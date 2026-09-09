'use strict';

const childProcess = require('child_process');

const CONFIG = require('../config');

// Debian 13 (trixie) compatibility, tmiland-lab fork:
// - apm's bundled node-gyp (5.1.0) cannot run under modern Python; install
//   apm deps without scripts, swap in node-gyp 9.4.1 (script/patches), then
//   rebuild the native modules with it.
// - atom.io's electron headers endpoint serves corrupted tarballs; default to
//   electronjs.org (overridable via ATOM_ELECTRON_URL).
// - Electron headers lack the openssl_fips variable old binding.gyp files
//   condition on; provide an empty default (overridable via GYP_DEFINES).
module.exports = function(ci) {
  if (ci) {
    // Tell apm not to dedupe its own dependencies during its
    // postinstall script. (Deduping during `npm ci` runs is broken.)
    process.env.NO_APM_DEDUPE = 'true';
  }
  process.env.ATOM_ELECTRON_URL =
    process.env.ATOM_ELECTRON_URL || 'https://electronjs.org/headers';
  process.env.GYP_DEFINES = process.env.GYP_DEFINES || 'openssl_fips= ';
  console.log('Installing apm');
  childProcess.execFileSync(
    CONFIG.getLocalNpmBinPath(),
    ['--global-style', '--loglevel=error', '--ignore-scripts', ci ? 'ci' : 'install'],
    { env: process.env, cwd: CONFIG.apmRootPath }
  );
  const fs = require('fs');
  const path = require('path');
  const bundledGyp = path.join(
    CONFIG.apmRootPath,
    'node_modules/atom-package-manager/node_modules/npm/node_modules/node-gyp'
  );
  const patchedGyp = path.join(__dirname, '..', 'patches', 'node-gyp');
  if (fs.existsSync(patchedGyp)) {
    childProcess.execFileSync('rm', ['-rf', bundledGyp]);
    childProcess.execFileSync('cp', ['-a', patchedGyp, bundledGyp]);
    console.log('Patched apm node-gyp to 9.4.1');
  }
  console.log('Rebuilding apm native modules');
  childProcess.execFileSync(
    CONFIG.getLocalNpmBinPath(),
    ['--global-style', '--loglevel=error', 'rebuild'],
    { env: process.env, cwd: CONFIG.apmRootPath }
  );
};
