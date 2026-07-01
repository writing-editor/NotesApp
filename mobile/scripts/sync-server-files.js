const fs = require('fs');
const path = require('path');

const MOBILE_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT   = path.resolve(MOBILE_ROOT, '..');
const APP_CODE    = path.join(REPO_ROOT, 'AppCode');
const WWW         = path.join(MOBILE_ROOT, 'www');
const NODEJS_DIR  = path.join(WWW, 'nodejs');
const NODEJS_PUB  = path.join(NODEJS_DIR, 'public');

function copyFile(src, dest) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return true;
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.cpSync(src, dest, { recursive: true });
}

function generateNodejsPackageJson() {
  const rootPkgPath = path.join(APP_CODE, 'package.json');
  const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'));
  const deps = { ...rootPkg.dependencies };
  
  delete deps['puppeteer'];
  delete deps['puppeteer-core'];
  
  // FORCE inject isomorphic-git so the Node server doesn't crash on require()
  deps['isomorphic-git'] = '^1.27.1';
  
  const innerPkg = {
    name: "manuscript-embedded",
    version: "1.0.0",
    private: true,
    main: "index.js",
    dependencies: deps
  };
  fs.writeFileSync(path.join(NODEJS_DIR, 'package.json'), JSON.stringify(innerPkg, null, 2));
}

function main() {
  // 1. Copy Server logic
  copyFile(path.join(APP_CODE, 'server.js'), path.join(NODEJS_DIR, 'server.js'));
  copyDir(path.join(APP_CODE, 'lib'), path.join(NODEJS_DIR, 'lib'));
  copyFile(path.join(APP_CODE, 'sw.js'), path.join(NODEJS_DIR, 'sw.js'));
  
  // 2. Copy Web Assets INTO the Node server's public folder so Express can serve them
  ['index.html', 'styles.css', 'client.js'].forEach(f => {
    copyFile(path.join(APP_CODE, 'public', f), path.join(NODEJS_PUB, f));
  });

  // 3. Generate inner package.json
  generateNodejsPackageJson();

 // 4. Create the Capacitor Bootloader (solves the race condition + shows errors)
  const bootloaderHtml = `
  <!DOCTYPE html>
  <html style="background:#f4f2ee; color:#1c1a18; font-family:monospace; padding: 20px;">
  <head><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
  <body>
  <h3>Starting Manuscript Server...</h3>
  <p id="log" style="line-height:1.5;">Waiting for Node.js runtime...</p>
  <script>
    let attempts = 0;
    function ping() {
      attempts++;
      document.getElementById('log').innerText = 'Attempting connection... (' + attempts + ')';
      
      fetch('http://127.0.0.1:8723/api/vault')
        .then(async r => {
          const data = await r.json().catch(() => ({}));
          
          if (data && data.error === 'NODE_CRASH') {
            // Node crashed! Print the stack trace to the screen.
            document.getElementById('log').innerHTML = 
              '<strong style="color:#c0392b">Node.js Crashed:</strong><br><br>' + 
              data.stack.replace(/\\n/g, '<br>');
          } else {
            // Success! Load the app.
            window.location.href = 'http://127.0.0.1:8723/';
          }
        })
        .catch(e => setTimeout(ping, 500));
    }
    setTimeout(ping, 500);
  </script>
  </body></html>
  `;
  fs.writeFileSync(path.join(WWW, 'index.html'), bootloaderHtml, 'utf8');
  
  console.log('[sync-files] Built bootloader and synced files successfully.');
}

main();