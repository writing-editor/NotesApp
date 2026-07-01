const path = require('path');
const fs   = require('fs');
const os   = require('os');
const http = require('http');

const PORT = process.env.PORT || '8723';

// Safely resolve the data path.
let dataPath = os.homedir();
if (!dataPath || dataPath === '/') {
    // Fallback if Android restricts homedir
    dataPath = path.resolve(__dirname, '../../..'); 
}

const repoRoot = path.join(dataPath, 'MyWritings');
const vaultPath = path.join(repoRoot, 'book');

process.env.PORT = PORT;
process.env.GIT_ROOT = repoRoot;
process.argv[2] = fs.existsSync(vaultPath) ? vaultPath : undefined;

try {
    // Attempt to boot the actual app
    require('./server.js');
} catch (err) {
    // IF THE APP CRASHES: Start a rescue server to show the error on the phone!
    http.createServer((req, res) => {
        res.writeHead(200, { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*' 
        });
        res.end(JSON.stringify({ error: "NODE_CRASH", stack: err.stack }));
    }).listen(PORT, '0.0.0.0');
}