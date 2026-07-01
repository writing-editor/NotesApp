const fs = require('fs');
const path = require('path');

const MOBILE_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT   = path.resolve(MOBILE_ROOT, '..');
const APP_CODE    = path.join(REPO_ROOT, 'AppCode');
const WWW         = path.join(MOBILE_ROOT, 'www');
const NODEJS_DIR  = path.join(WWW, 'nodejs');

function copyFile(src, dest) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`[sync-files] copied ${path.relative(REPO_ROOT, src)} -> ${path.relative(REPO_ROOT, dest)}`);
  return true;
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.cpSync(src, dest, { recursive: true });
  console.log(`[sync-files] copied dir ${path.relative(REPO_ROOT, src)} -> ${path.relative(REPO_ROOT, dest)}`);
}

function generateNodejsPackageJson() {
  const rootPkgPath = path.join(APP_CODE, 'package.json');
  if (!fs.existsSync(rootPkgPath)) throw new Error('AppCode/package.json not found');
  
  const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'));
  const deps = { ...rootPkg.dependencies };
  
  // Exclude native/desktop-only deps per Section 6.5
  delete deps['puppeteer'];
  delete deps['puppeteer-core'];
  
  const innerPkg = {
    name: "manuscript-embedded",
    version: "1.0.0",
    private: true,
    main: "index.js",
    dependencies: deps
  };
  
  fs.mkdirSync(NODEJS_DIR, { recursive: true });
  fs.writeFileSync(path.join(NODEJS_DIR, 'package.json'), JSON.stringify(innerPkg, null, 2), 'utf8');
  console.log('[sync-files] generated mobile/www/nodejs/package.json');
}

function main() {
  console.log(`[sync-files] AppCode root: ${APP_CODE}`);
  
  copyFile(path.join(APP_CODE, 'server.js'), path.join(NODEJS_DIR, 'server.js'));
  copyDir(path.join(APP_CODE, 'lib'), path.join(NODEJS_DIR, 'lib'));
  copyFile(path.join(APP_CODE, 'sw.js'), path.join(NODEJS_DIR, 'sw.js'));
  
  ['index.html', 'styles.css', 'client.js'].forEach(f => {
    copyFile(path.join(APP_CODE, 'public', f), path.join(WWW, f));
  });

  // Generate the package.json required for the embedded node runtime
  generateNodejsPackageJson();

  console.log('[sync-files] done.');
}

main();