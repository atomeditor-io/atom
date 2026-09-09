'use strict';

const childProcess = require('child_process');

const CONFIG = require('../config');

// Debian 13 / Electron-modern chase (tmiland-lab fork): extraInstallEnv lets
// callers add npm_config_* overrides for a specific install. The transpile
// step uses npm_config_ignore_scripts=true because bundled packages' devDep
// chains (e.g. github -> electron-link -> leveldown@5.6.0 -> nan@2.14) carry
// native install scripts that cannot compile on modern V8/Node-API levels —
// and those devDeps are never executed during transpilation.
module.exports = function(packagePath, ci, stdioOptions, extraInstallEnv) {
  const installEnv = Object.assign({}, process.env, extraInstallEnv);
  // Set resource path so that apm can load metadata related to Atom.
  installEnv.ATOM_RESOURCE_PATH = CONFIG.repositoryRootPath;

  childProcess.execFileSync(CONFIG.getApmBinPath(), [ci ? 'ci' : 'install'], {
    env: installEnv,
    cwd: packagePath,
    stdio: stdioOptions || 'inherit'
  });
};
