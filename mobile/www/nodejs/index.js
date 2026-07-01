const path = require('path');
const fs   = require('fs');
const os   = require('os');

// os.homedir() inside Capacitor Node maps perfectly to Android's private, encrypted app-data folder.
const dataPath = os.homedir();
const repoRoot = path.join(dataPath, 'MyWritings');
const vaultPath = path.join(repoRoot, 'book');

// Match the bootloader's target port
process.env.PORT = process.env.PORT || '8723';
process.env.GIT_ROOT = repoRoot;

// Handle first-time launch state
process.argv[2] = fs.existsSync(vaultPath) ? vaultPath : undefined;

require('./server.js');