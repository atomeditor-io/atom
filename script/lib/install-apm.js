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
    // fs-level copy (not cp -a): dereference symlinks so the swap also works
    // on Windows, where creating symlinks requires special privileges.
    const fsExtra = require('fs-extra');
    fsExtra.removeSync(bundledGyp);
    fsExtra.copySync(patchedGyp, bundledGyp, { dereference: true });
    console.log('Patched apm node-gyp to 9.4.1');
  }
  patchApmSearchForStaticRegistry();
  console.log('Rebuilding apm native modules');
  childProcess.execFileSync(
    CONFIG.getLocalNpmBinPath(),
    ['--global-style', '--loglevel=error', 'rebuild'],
    { env: process.env, cwd: CONFIG.apmRootPath }
  );
};

// atomeditor.io fork: the atom.io registry (GET /api/packages/search?q=...) is
// dead, and our replacement is a STATIC site that can only serve the full
// package index, not arbitrary per-query responses. Patch the bundled apm to
// fetch the whole index once and filter it locally so `apm search`, the
// settings-view Install pane and the CLI all keep working against the live
// registry (default https://atomeditor.io/api, overridable via ATOM_API_URL).
function patchApmSearchForStaticRegistry() {
  const fs = require('fs');
  const path = require('path');
  const searchPath = path.join(
    CONFIG.apmRootPath,
    'node_modules/atom-package-manager/lib/search.js'
  );
  if (!fs.existsSync(searchPath)) {
    console.warn('apm search.js not found; skipping registry patch');
    return;
  }
  let src = fs.readFileSync(searchPath, 'utf8');
  if (src.indexOf('stateless registry') !== -1) return;

  const urlOld = 'requestSettings = {\n        url: (config.getAtomPackagesUrl()) + "/search",\n        qs: qs,\n        json: true\n      };';
  const urlNew = 'requestSettings = {\n        // atomeditor.io stateless registry: the static site cannot answer\n        // ?q= queries; fetch the full index once and filter locally below.\n        url: (config.getAtomApiUrl()) + "/packages",\n        json: true\n      };';
  if (src.indexOf(urlOld) !== -1) {
    src = src.replace(urlOld, urlNew);
  } else {
    console.warn('apm search.js url block not found; registry patch partial');
  }

  const mapOld = 'packages = body.filter(function(pack) {\n            var ref;\n            return ((ref = pack.releases) != null ? ref.latest : void 0) != null;\n          });';
  const localFilter = 'packages = body.filter(function(pack) {\n            var ref;\n            return ((ref = pack.releases) != null ? ref.latest : void 0) != null;\n          });\n          (function() {\n            var filter, hay, i, len, q;\n            q = String(query || "").toLowerCase();\n            if (opts.packages) {\n              filter = false;\n            } else if (opts.themes) {\n              filter = true;\n            } else {\n              filter = null;\n            }\n            packages = packages.filter(function(pack) {\n              var metadata, ref1;\n              metadata = pack.metadata || {};\n              if (filter !== null && !!metadata.theme !== filter) {\n                return false;\n              }\n              if (!q) {\n                return true;\n              }\n              hay = (((metadata.name) != null ? metadata.name : "") + " " + ((metadata.description) != null ? metadata.description : "")).toLowerCase();\n              return hay.indexOf(q) !== -1;\n            });\n          })();';
  if (src.indexOf(mapOld) !== -1) {
    src = src.replace(mapOld, localFilter);
  } else {
    console.warn('apm search.js filter block not found; registry patch partial');
  }

  src = '// patched for the atomeditor.io stateless registry (post-install)\n' + src;
  fs.writeFileSync(searchPath, src);
  console.log('Patched apm search for static registry (local filter)');
}
