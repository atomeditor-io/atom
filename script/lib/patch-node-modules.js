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

// Electron 12+ rejects non-context-aware native modules in the renderer
// (https://github.com/electron/electron/issues/18397). Atom's NAN-era natives
// register with plain NODE_MODULE and crash on first require in the renderer.
// Convert their registration to NODE_MODULE_CONTEXT_AWARE (same one-arg init),
// rebuild for the Electron target, and reseed every nested copy from the root
// build. Idempotent; skipped when the source already registers context-aware.
const CONTEXT_AWARE_PACKAGES = [
  'oniguruma',
  'pathwatcher',
  'git-utils',
  '@atom/nsfw',
  '@atom/fuzzy-native',
  'ctags',
  'keyboard-layout',
  'fs-admin',
  'superstring',
  '@atom/watcher',
  'tree-sitter'
];

const NODE_MODULE_RE = /NODE_MODULE\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*([A-Za-z0-9_:]+?)\s*\)/;

// Determine how many arguments the native init function takes by inspecting
// its definition in the same file. Addon inits come in three shapes:
//   void Init(Local<Object> exports)                  -> Init(exports)
//   void Init(Local<Object> exports, Local<Object>)    -> Init(exports, module)
//     (older NAN/tree-sitter-grammar style; module is Local<Value>-compatible)
//   NAN_MODULE_INIT(Init)                             -> Init(exports)
function initCallArgs(text, func) {
  const shortName = func.includes('::') ? func.split('::').pop() : func;
  const esc = shortName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const nanInit = new RegExp('NAN_MODULE_INIT\\s*\\(\\s*' + esc + '\\s*\\)');
  if (nanInit.test(text)) {
    return 'exports';
  }
  const defRe = new RegExp(
    '(?:^|[^A-Za-z0-9_:])(?:void\\s+)?([A-Za-z0-9_:]*' +
      esc +
      ')\\s*\\(([^)]*)\\)',
    'gm'
  );
  let m;
  while ((m = defRe.exec(text)) !== null) {
    const fullName = m[1];
    if (fullName !== func && fullName !== shortName) {
      continue;
    }
    const params = m[2].trim();
    if (!params) return 'exports';
    const count = params.split(',').length;
    if (count >= 3) return 'exports, module, context';
    if (count === 2) return 'exports, v8::Local<v8::Object>::Cast(module)';
  }
  return 'exports';
}

function discoverNativeTargets(nodeModulesRoot) {
  const targets = [...CONTEXT_AWARE_PACKAGES];
  let entries;
  try {
    entries = fs.readdirSync(nodeModulesRoot, { withFileTypes: true });
  } catch (e) {
    return targets;
  }
  for (const entry of entries) {
    // Tree-sitter language grammars (tree-sitter-c, tree-sitter-python,
    // ...) are plain NAN modules too and need the same treatment.
    if (
      entry.isDirectory() &&
      entry.name.startsWith('tree-sitter-') &&
      !targets.includes(entry.name) &&
      fs.existsSync(path.join(nodeModulesRoot, entry.name, 'package.json'))
    ) {
      targets.push(entry.name);
    }
  }
  return targets;
}

function patchContextAwareSources(nodeModulesRoot) {
  const patched = [];
  for (const pkg of discoverNativeTargets(nodeModulesRoot)) {
    const base = path.join(nodeModulesRoot, pkg);
    if (!fs.existsSync(path.join(base, 'package.json'))) {
      continue;
    }
    let changed = false;
    const stack = [[base, 0]];
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
          if (['node_modules', 'build', 'test', 'spec', 'vendor'].includes(entry.name)) continue;
          stack.push([full, depth + 1]);
        } else if (/\.(cc|cpp|c)$/.test(entry.name)) {
          let text;
          try {
            text = fs.readFileSync(full, 'utf8');
          } catch (e) {
            continue;
          }
          if (text.includes('NODE_MODULE_CONTEXT_AWARE') || !NODE_MODULE_RE.test(text)) {
            continue;
          }
          const replacement = text.replace(
            NODE_MODULE_RE,
            (match, mod, func) => {
              const sym = 'ca_register_' + mod + '_' + func.replace(/::/g, '_');
              const callArgs = initCallArgs(text, func);
              return (
                `static void ${sym}(v8::Local<v8::Object> exports, v8::Local<v8::Value> module, v8::Local<v8::Context> context, void* priv) {\n` +
                `  ${func}(${callArgs});\n` +
                `}\n` +
                `NODE_MODULE_CONTEXT_AWARE(${mod}, ${sym})`
              );
            }
          );
          fs.writeFileSync(full, replacement);
          changed = true;
        }
      }
    }
    if (changed) {
      patched.push(pkg);
    }
  }
  return patched;
}

function nativeBinaryPaths(pkgRoot) {
  const dir = path.join(pkgRoot, 'build', 'Release');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(f => f.endsWith('.node'))
    .map(f => path.join(dir, f));
}

function rebuildNativeForElectron(nodeModulesRoot, pkg) {
  const pkgRoot = path.join(nodeModulesRoot, pkg);
  const gypBin = path.join(
    CONFIG.repositoryRootPath,
    'script',
    'patches',
    'node-gyp',
    'bin',
    'node-gyp.js'
  );
  console.log(`Rebuilding ${pkg} context-aware for Electron ${CONFIG.appMetadata.electronVersion}`);
  childProcess.spawnSync(
    process.execPath,
    [
      gypBin,
      'rebuild',
      '--target=' + CONFIG.appMetadata.electronVersion,
      '--dist-url=' + (process.env.ATOM_ELECTRON_URL || 'https://electronjs.org/headers'),
      '--arch=' + (process.arch === 'arm64' ? 'arm64' : 'x64')
    ],
    { stdio: 'inherit', cwd: pkgRoot, env: process.env }
  );
  if (!nativeBinaryPaths(pkgRoot).length) {
    throw new Error(`native rebuild produced no .node for ${pkg}`);
  }
}

function reseedNestedNativeCopies(repositoryRootPath, nodeModulesRoot, pkg) {
  const pkgRoot = path.join(nodeModulesRoot, pkg);
  const binaries = nativeBinaryPaths(pkgRoot);
  if (!binaries.length) return;
  const marker = path.join(pkgRoot, 'build', 'Release', '.context-aware');
  fs.writeFileSync(marker, 'patched and rebuilt\n');
  const roots = [
    path.join(repositoryRootPath, 'node_modules'),
    path.join(repositoryRootPath, 'packages')
  ];
  let seeded = 0;
  for (const walkRoot of roots) {
    if (!fs.existsSync(walkRoot)) continue;
    const stack = [[walkRoot, 0]];
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
        if (!entry.isDirectory()) continue;
        if (entry.name === pkg && path.dirname(full) !== nodeModulesRoot) {
          const destDir = path.join(full, 'build', 'Release');
          if (fs.existsSync(path.join(full, 'package.json')) && fs.existsSync(destDir)) {
            for (const bin of binaries) {
              fs.copyFileSync(bin, path.join(destDir, path.basename(bin)));
            }
            seeded++;
          }
          continue;
        }
        stack.push([full, depth + 1]);
      }
    }
  }
  if (seeded) {
    console.log(`Reseeded ${seeded} nested copy/copies of ${pkg}`);
  }
}

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
  const caPatched = patchContextAwareSources(root);
  for (const pkg of caPatched) {
    rebuildNativeForElectron(root, pkg);
    reseedNestedNativeCopies(CONFIG.repositoryRootPath, root, pkg);
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
