// electron/main.js
//
// Desktop shell for ManuScript on Linux (Ubuntu).
//
// Design: reuse AppCode/server.js completely unmodified. It's a normal
// Express app that reads/writes a real folder on disk (the "vault") and
// binds an HTTP port — exactly what a laptop app should be, and exactly
// what the README already describes as "Using it on your laptop". Electron
// just replaces "open a terminal and a browser tab" with "double-click an
// icon", by spawning that same server as a child process and pointing a
// BrowserWindow at it.
//
// This mirrors the mobile app's philosophy in spirit (same server.js code
// path, no cloud service) while being much simpler than the mobile build:
// on a laptop there is a real filesystem and a real Node runtime, so none
// of the mobile app's LightningFS / service-worker / git-in-the-browser
// machinery is needed here.

const { app, BrowserWindow, Menu, dialog, shell, ipcMain, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { fork } = require('child_process');

// ── Paths ────────────────────────────────────────────────────────────────
// In development we run from the repo checkout: electron/ sits next to
// AppCode/ and book/. When packaged by electron-builder, AppCode is copied
// into the app's resources folder (see package.json "build.extraResources"),
// and node_modules for AppCode ships alongside it there too.
const isPackaged = app.isPackaged;

const APP_CODE_DIR = isPackaged
  ? path.join(process.resourcesPath, 'AppCode')
  : path.join(__dirname, '..', 'AppCode');

const SERVER_ENTRY = path.join(APP_CODE_DIR, 'server.js');

// Default vault used the very first time the app runs (matches the repo's
// own book/ folder — same default the `npm start` script in AppCode uses).
const DEFAULT_VAULT_DIR = isPackaged
  ? path.join(process.resourcesPath, 'book')
  : path.join(__dirname, '..', 'book');

// Where we remember the last vault the user picked, so re-opening the app
// goes straight back to their manuscript instead of the bundled sample.
const CONFIG_PATH = path.join(app.getPath('userData'), 'desktop-config.json');

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (e) {
    console.error('[desktop] failed to save config:', e.message);
  }
}

function resolveInitialVault() {
  const cfg = readConfig();
  if (cfg.vault && fs.existsSync(cfg.vault)) return cfg.vault;
  return DEFAULT_VAULT_DIR;
}

// ── Server process management ───────────────────────────────────────────
// The server is run with `fork()` (a real child Node process, not just an
// in-process require) so a crash in server.js can never take the Electron
// UI process down with it, and so we get a clean child to kill/restart when
// the user picks a different vault from the native menu.
let serverProcess = null;
let serverPort = null;
let mainWindow = null;

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function waitForServer(port, timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (function attempt() {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/vault', timeout: 1000 }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error('Server did not start in time'));
        } else {
          setTimeout(attempt, 200);
        }
      });
      req.on('timeout', () => req.destroy());
    })();
  });
}

async function startServer(vaultPath) {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }

  if (!fs.existsSync(SERVER_ENTRY)) {
    throw new Error(`Cannot find server entry at ${SERVER_ENTRY}`);
  }

  serverPort = await pickFreePort();

  serverProcess = fork(SERVER_ENTRY, [vaultPath], {
    cwd: APP_CODE_DIR,
    env: {
      ...process.env,
      PORT: String(serverPort),
    },
    // Keep the server's console output visible in dev; pipe in production
    // so it lands in Electron's logs instead of an invisible console.
    stdio: isPackaged ? 'pipe' : 'inherit',
  });

  if (isPackaged) {
    serverProcess.stdout?.on('data', (d) => console.log(`[server] ${d}`.trimEnd()));
    serverProcess.stderr?.on('data', (d) => console.error(`[server] ${d}`.trimEnd()));
  }

  serverProcess.on('exit', (code) => {
    console.log(`[desktop] server process exited with code ${code}`);
  });

  await waitForServer(serverPort);
  return serverPort;
}

// ── Window ───────────────────────────────────────────────────────────────
// The app's own paper/ink theme (AppCode/public/styles.css :root), duplicated
// here so the native window chrome can match it instead of looking like a
// separate grey OS panel stuck on top of the app.
const THEME = {
  paper: '#f4f2ee',
  ink: '#1c1a18',
};

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 760,
    minHeight: 540,
    backgroundColor: THEME.paper,
    icon: path.join(__dirname, 'build-resources', 'icon.png'),
    // No native title bar/menu banner, and no OS-drawn border around it —
    // we draw our own minimal draggable strip (below) colored to match the
    // app so the window reads as one continuous surface instead of an app
    // sitting inside a separate grey title-bar panel.
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${serverPort}/`);

  // Inject a thin draggable title-bar strip with min/max/close buttons once
  // the real page has loaded, rather than editing AppCode/public/index.html
  // (that file is shared with the mobile build, which has no window chrome
  // to speak of). Colors are pulled from THEME above so this can never drift
  // out of sync with a change to styles.css without someone noticing here.
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.insertCSS(`
      .__desktop-titlebar {
        position: fixed; top: 0; left: 0; right: 0; height: 32px;
        display: flex; align-items: center; justify-content: flex-end;
        background: ${THEME.paper};
        -webkit-app-region: drag;
        z-index: 999999;
      }
      .__desktop-titlebar button {
        -webkit-app-region: no-drag;
        width: 46px; height: 32px; border: none; background: transparent;
        color: ${THEME.ink}; opacity: 0.55; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        font-family: sans-serif; font-size: 14px; line-height: 1;
        transition: background 0.12s, opacity 0.12s;
      }
      .__desktop-titlebar button:hover { opacity: 1; background: rgba(0,0,0,0.06); }
      .__desktop-titlebar button.__close:hover { background: #c0392b; color: #fff; opacity: 1; }
      body { padding-top: 32px !important; box-sizing: border-box; }
    `);

    mainWindow.webContents.executeJavaScript(`
      (function () {
        if (document.querySelector('.__desktop-titlebar')) return;
        var bar = document.createElement('div');
        bar.className = '__desktop-titlebar';
        bar.innerHTML =
          '<button class="__min" title="Minimize">&#x2013;</button>' +
          '<button class="__max" title="Maximize">&#x25A1;</button>' +
          '<button class="__close" title="Close">&#x2715;</button>';
        document.body.prepend(bar);
        bar.querySelector('.__min').onclick = () => window.manuscriptDesktop.winMinimize();
        bar.querySelector('.__max').onclick = () => window.manuscriptDesktop.winMaximizeToggle();
        bar.querySelector('.__close').onclick = () => window.manuscriptDesktop.winClose();
      })();
    `);
  });

  // Open any target="_blank" / window.open() links (e.g. a git remote URL)
  // in the user's real browser instead of a second Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── Native "Open Vault Folder" flow ─────────────────────────────────────
// Complements the in-app filesystem browser (/api/browse) with a real
// native folder picker, then points the running server at the chosen
// folder and remembers it for next launch.
async function openVaultDialog() {
  if (!mainWindow) return;

  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose your manuscript vault folder',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: resolveInitialVault(),
  });

  if (result.canceled || !result.filePaths[0]) return;
  const chosen = result.filePaths[0];

  try {
    await fetch(`http://127.0.0.1:${serverPort}/api/vault`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: chosen }),
    });
    writeConfig({ ...readConfig(), vault: chosen });
    mainWindow.webContents.reload();
  } catch (e) {
    dialog.showErrorBox('Could not open vault', e.message);
  }
}

ipcMain.handle('open-vault-dialog', openVaultDialog);

ipcMain.handle('win-minimize', () => mainWindow?.minimize());
ipcMain.handle('win-maximize-toggle', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.handle('win-close', () => mainWindow?.close());

// ── Menu ─────────────────────────────────────────────────────────────────
// No visible menu bar (the File/Edit/View/Window banner) — it doesn't match
// a single-purpose reading/editing app and duplicates buttons already in the
// page itself. Menu.setApplicationMenu(null) removes the bar on Linux/Windows
// entirely. "Open Vault Folder" and dev tools are still reachable via global
// shortcuts registered below, and Ctrl/Cmd+Q or the custom close button quit.
function buildMenu() {
  Menu.setApplicationMenu(null);

  globalShortcut.register('CmdOrCtrl+O', openVaultDialog);
  globalShortcut.register('CmdOrCtrl+Shift+I', () => mainWindow?.webContents.toggleDevTools());
  globalShortcut.register('CmdOrCtrl+R', () => mainWindow?.webContents.reload());
}

// ── App lifecycle ────────────────────────────────────────────────────────
app.on('window-all-closed', () => {
  if (serverProcess) serverProcess.kill();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (serverProcess) serverProcess.kill();
  globalShortcut.unregisterAll();
});

app.whenReady().then(async () => {
  buildMenu();

  const vault = resolveInitialVault();
  try {
    await startServer(vault);
  } catch (e) {
    dialog.showErrorBox('ManuScript failed to start', e.message);
    app.quit();
    return;
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});