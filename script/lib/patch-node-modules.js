'use strict';

const childProcess = require('child_process');
const fs = require('fs-extra');
const path = require('path');

const CONFIG = require('../config');

// Debian 13 (gcc 14) compatibility, tmiland-lab fork.
// Old native sources stopped compiling against modern gcc; apply small,
// idempotent source fixes and pre-seed per-package dependency trees with the
// already-built native modules so their apm installs skip recompiling.
const NATIVE_PACKAGES = ['superstring'];

function patchSuperstringSources(nodeModulesRoot) {
  const headerPath = path.join(
    nodeModulesRoot,
    'superstring',
    'src',
    'core',
    'regex.h'
  );
  if (!fs.existsSync(headerPath)) {
    return false;
  }
  const contents = fs.readFileSync(headerPath, 'utf8');
  if (contents.includes('#include <cstdint>')) {
    return false;
  }
  fs.writeFileSync(
    headerPath,
    contents.replace(
      '#include <string>',
      '#include <cstdint>\n#include <string>'
    )
  );
  return true;
}

function superstringIsBuilt(nodeModulesRoot) {
  const buildDir = path.join(
    nodeModulesRoot,
    'superstring',
    'build',
    'Release'
  );
  return fs.existsSync(buildDir) && fs.readdirSync(buildDir).some(f => f.endsWith('.node'));
}

function buildSuperstring() {
  console.log('Rebuilding superstring for Electron');
  childProcess.execFileSync(
    CONFIG.getLocalNpmBinPath(),
    [
      'rebuild',
      '--target=' + CONFIG.appMetadata.electronVersion,
      '--disturl=' + (process.env.ATOM_ELECTRON_URL || 'https://electronjs.org/headers'),
      '--arch=x64'
    ],
    { env: process.env, cwd: path.join(CONFIG.repositoryRootPath, 'node_modules', 'superstring') }
  );
}


function removeNodeGypBins(nodeModulesRoot) {
  const gypBins = [];
  const stack = [[nodeModulesRoot, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop();
    if (depth > 6) continue;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_gyp_bins") {
          gypBins.push(full);
        } else if (entry.name !== ".bin") {
          stack.push([full, depth + 1]);
        }
      }
    }
  }
  for (const dir of gypBins) {
    fs.removeSync(dir);
  }
  if (gypBins.length) {
    console.log("Removed " + gypBins.length + " node_gyp_bins dirs");
  }
}

module.exports = function patchNodeModules() {
  const root = path.join(CONFIG.repositoryRootPath, 'node_modules');
  const patched = patchSuperstringSources(root);
  removeNodeGypBins(root);
  if (patched && !superstringIsBuilt(root)) {
    buildSuperstring();
  }
  for (const packageName of Object.keys(
    CONFIG.appMetadata.packageDependencies
  )) {
    const packageNodeModules = path.join(root, packageName, 'node_modules');
    for (const nativeName of NATIVE_PACKAGES) {
      const source = path.join(root, nativeName);
      const destination = path.join(packageNodeModules, nativeName);
      if (
        fs.existsSync(source) &&
        superstringIsBuilt(root) &&
        !fs.existsSync(destination)
      ) {
        fs.ensureDirSync(packageNodeModules);
        fs.copySync(source, destination);
        console.log(`Pre-seeded ${packageName} with built ${nativeName}`);
      }
    }
  }
};

module.exports.scrub = function scrubOutputTree(rootPath) {
  removeNodeGypBins(rootPath);
};
