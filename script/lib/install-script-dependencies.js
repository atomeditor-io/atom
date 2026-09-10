'use strict';

const childProcess = require('child_process');

const CONFIG = require('../config');

// Recognised by '@electron/get', used by the 'electron-mksnapshot' and 'electron-chromedriver' dependencies
process.env.ELECTRON_CUSTOM_VERSION = CONFIG.appMetadata.electronVersion;

module.exports = function(ci) {
  console.log('Installing script dependencies');
  childProcess.execFileSync(
    CONFIG.getNpmBinPath(ci),
    ['--loglevel=error', ci ? 'ci' : 'install'],
    { env: process.env, cwd: CONFIG.scriptRootPath }
  );

  // tmiland-lab fork: overlay vendored electron-link patches (V8 9 snapshot walker)
  // Must run AFTER npm install creates script/node_modules/electron-link/.
  const fs = require('fs');
  const path = require('path');
  const patchedDir = path.join(__dirname, '..', 'patches', 'electron-link', 'lib');
  const targetDir = path.join(__dirname, '..', 'node_modules', 'electron-link', 'lib');
  if (fs.existsSync(patchedDir) && fs.existsSync(targetDir)) {
    for (const file of fs.readdirSync(patchedDir)) {
      fs.copyFileSync(path.join(patchedDir, file), path.join(targetDir, file));
    }
    console.log('Patched electron-link for V8 9 snapshot compatibility');
  }
};
