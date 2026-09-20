'use strict';

const childProcess = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const { transpileGithubEsm } = require('./transpile-github-esm');

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
  'tree-sitter',
  'spellchecker'
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

// first-mate scanner: oniguruma's OnigScanner is the native underline of every
// syntax token. If it arrives as a SILENT placeholder (native loads, but
// search ends up absent because the .node ABI is wrong for this Electron and
// the error was swallowed), tokenization fails SILENTLY: the editor shows
// root-only scope, zero colors, no console error. That dead-silence is the
// worst possible failure mode for a rebuild test. Make it LOUD so any future
// build either tokenizes normally or prints the exact native path + the one
// reason it could not search. Idempotent: skips if the guard marker is
// already present (survives repeated patch-node-modules runs).
function patchFirstMateScannerLoudGuard(nodeModulesRoot) {
  const rel = ['first-mate', 'lib', 'scanner.js'];
  const filePath = path.join(nodeModulesRoot, ...rel);
  if (!fs.existsSync(filePath)) return false;
  const contents = fs.readFileSync(filePath, 'utf8');
  const marker = '[first-mate/scanner] OnigScanner is a SILENT PLACEHOLDER';
  if (contents.includes(marker)) return false;
  const anchor = 'scanner = new OnigScanner(patterns);';
  if (!contents.includes(anchor)) return false;
  // OnigScanner.prototype has no `search` method: its real API on Electron is
  // `findNextMatchSync`. Only a stub/placeholder would lack it, so that is the
  // correct probe. (Checking `search` would false-positive on every healthy
  // native build and spam `[first-mate/scanner] SILENT PLACEHOLDER`.)
  const guard =
    anchor +
    "\n      if ((scanner == null) || (typeof scanner.findNextMatchSync !== 'function')) {\n        try {\n          var requiredPath = require.resolve('oniguruma');\n          console.error(\n            '[first-mate/scanner] OnigScanner is a SILENT PLACEHOLDER (findNextMatchSync not a function). ' +\n            'Native tokenization is DISABLED in this build. native=' +\n            require.resolve('oniguruma/build/Release/onig_scanner.node') + ' ABI=' +\n            (process.versions != null ? process.versions.modules : '?')\n          );\n        } catch (e) {\n          console.error('[first-mate/scanner] oniguruma unresolvable: ' + e.message);\n        }\n      }";
  const patched = contents.replace(anchor, guard);
  if (patched !== contents) {
    fs.writeFileSync(filePath, patched);
    console.log('Patched first-mate/lib/scanner.js (loud oniguruma guard)');
  }
  return patched !== contents;
}

// Packages with native bindings that must NOT be touched:
// - nslog: main-process-only logging (required by src/main-process/start.js);
//   the renderer context-aware requirement never applies to it.
const NATIVE_SKIP_LIST = ['nslog'];

// Native modules the packaged app actually loads. Rebuilt against the Electron
// target on every bootstrap so clean installs (apm ci with ignore-scripts)
// end up with working binaries regardless of fingerprint state. nsfw and
// keytar are N-API; the rest are patch-to-NODE_MODULE_CONTEXT_AWARE candidates.
const SHIPPED_NATIVE_PACKAGES = [
  ...CONTEXT_AWARE_PACKAGES.filter(p => p !== 'nslog'),
  'keytar',
  'scrollbar-style',
  'nslog'
];

function discoverNativeTargets(nodeModulesRoot) {
  const targets = [...CONTEXT_AWARE_PACKAGES];
  let entries;
  try {
    entries = fs.readdirSync(nodeModulesRoot, { withFileTypes: true });
  } catch (e) {
    return targets;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (targets.includes(entry.name)) continue;
    if (NATIVE_SKIP_LIST.includes(entry.name)) continue;
    const pkgDir = path.join(nodeModulesRoot, entry.name);
    // Any root package shipping a binding.gyp is a native module candidate.
    // Packages without plain NODE_MODULE registrations (N-API, already
    // context-aware) are harmless no-ops in the patch step below.
    if (
      fs.existsSync(path.join(pkgDir, 'package.json')) &&
      fs.existsSync(path.join(pkgDir, 'binding.gyp'))
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
          if (
            ['node_modules', 'build', 'test', 'spec', 'vendor'].includes(
              entry.name
            )
          )
            continue;
          stack.push([full, depth + 1]);
        } else if (/\.(cc|cpp|c)$/.test(entry.name)) {
          let text;
          try {
            text = fs.readFileSync(full, 'utf8');
          } catch (e) {
            continue;
          }
          if (
            text.includes('NODE_MODULE_CONTEXT_AWARE') ||
            !NODE_MODULE_RE.test(text)
          ) {
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
  rebuildNativeAtPath(path.join(nodeModulesRoot, pkg), pkg);
}

function rebuildNativeAtPath(pkgRoot, label) {
  const gypBin = path.join(
    CONFIG.repositoryRootPath,
    'script',
    'patches',
    'node-gyp',
    'bin',
    'node-gyp.js'
  );
  console.log(
    `Rebuilding ${label} context-aware for Electron ${
      CONFIG.appMetadata.electronVersion
    }`
  );
  childProcess.spawnSync(
    process.execPath,
    [
      gypBin,
      'rebuild',
      '--target=' + CONFIG.appMetadata.electronVersion,
      '--dist-url=' +
        (process.env.ATOM_ELECTRON_URL || 'https://electronjs.org/headers'),
      '--arch=' + (process.arch === 'arm64' ? 'arm64' : 'x64')
    ],
    { stdio: 'inherit', cwd: pkgRoot, env: process.env }
  );
  if (!nativeBinaryPaths(pkgRoot).length) {
    throw new Error(`native rebuild produced no .node for ${label}`);
  }
}

// Shipping status of the git/ripgrep binaries the GitHub package needs.
// `apm ci` uses npm_config_ignore_scripts=true (see script/bootstrap), so the
// dugite postinstall (download-git) and vscode-ripgrep postinstall (binary
// download) never run. Without them the GitHub panel's git-process and the
// ripgrep searcher both die at runtime. Provision them here, exactly as the
// ignored postinstall scripts would, but only when the binary is missing (so
// re-runs are fast). Console noise is suppressed; failures surface via rc.
function ensureDirectory(command, cwd, description) {
  console.log(`Provisioning ${description}...`);
  const result = childProcess.spawnSync(command, {
    cwd,
    stdio: 'inherit',
    env: process.env
  });
  if (result.status !== 0) {
    throw new Error(`could not provision ${description} (rc=${result.status})`);
  }
}

function provisionBinaryDependencies(root) {
  const dugiteRoot = path.join(root, 'dugite');
  const gitBin = path.join(dugiteRoot, 'git', 'bin', 'git');
  if (!fs.existsSync(gitBin)) {
    ensureDirectory(
      process.execPath,
      dugiteRoot,
      'dugite embedded git via script/download-git.js'
    );
  } else {
    console.log('dugite embedded git already present.');
  }

  const ripgrepBin = path.join(
    root,
    'vscode-ripgrep',
    'bin',
    process.platform === 'win32' ? 'rg.exe' : 'rg'
  );
  if (!fs.existsSync(ripgrepBin)) {
    ensureDirectory(
      process.execPath,
      path.join(root, 'vscode-ripgrep'),
      'vscode-ripgrep binary via lib/postinstall.js'
    );
  } else {
    console.log('vscode-ripgrep binary already present.');
  }
}

// keytar is a runtime dependency of the GitHub package but lives NESTED under
// node_modules/github/node_modules/keytar (the outer node_modules has no keytar
// entry). The root-level SHIPPED_NATIVE_PACKAGES rebuild loop therefore never
// builds it, and its N-API binary is absent from every packaged app ->
// "Cannot find module '../build/Release/keytar.node'" on GitHub login/issue.
// Find any nested shipped-native copies and rebuild them in place.
function rebuildNestedShippedNatives(root) {
  const stack = [[root, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop();
    if (depth > 8) continue;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') {
          stack.push([full, depth + 1]);
          continue;
        }
        if (
          SHIPPED_NATIVE_PACKAGES.includes(entry.name) &&
          dir !== root &&
          fs.existsSync(path.join(full, 'package.json')) &&
          fs.existsSync(path.join(full, 'binding.gyp'))
        ) {
          // Nested copies of shipped natives resolve from the npm registry,
          // whose sources still call V8 APIs removed in modern Electron
          // (ArrayBuffer::GetContents, Function::CreationContext,
          // Object::GetIsolate). Rebuilding them can never succeed; when
          // the patched root copy has already been rebuilt against Electron
          // above, swap it in wholesale — same trick as the per-package
          // pre-seed below. Fall back to patch+rebuild for natives with no
          // root-level build (e.g. keytar).
          if (nativeBinaryPaths(path.join(root, entry.name)).length > 0) {
            console.log(
              `Replacing nested ${entry.name} with built root copy at ${full}`
            );
            fs.removeSync(full);
            fs.copySync(path.join(root, entry.name), full);
            stack.push([full, depth + 1]);
            continue;
          }
          // The GCC 14 <cstdint> fix is applied to the root-level copy by
          // patchNodeModules(); nested copies (e.g. under text-buffer) are
          // fresh from a clean install and need the same patch before gyp
          // can compile them.
          patchSuperstringSources(dir);
          rebuildNativeAtPath(full, entry.name + ' (nested)');
          stack.push([full, depth + 1]);
        } else {
          stack.push([full, depth + 1]);
        }
      }
    }
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
          if (
            fs.existsSync(path.join(full, 'package.json')) &&
            fs.existsSync(destDir)
          ) {
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

// Suppress startup DeprecationWarnings that clutter console/devtools:
// - DEP0180 (fs.Stats) is emitted by Electron's asar shim when yargs guesses
//   its package version by statting Up through app.asar at module load
//   (escalade/pkgUp). yargs' own callers (src/main-process, apm) pass an
//   explicit version, so the guess is dead weight -> make it constant.
// - React 16 "componentWillReceiveProps has been renamed" warning is raised
//   by github package views that still use the plain lifecycle name; rename
//   to the sanctioned UNSAFE_ form (same behavior, warning suppressed).
function patchDeprecatedUsage(nodeModulesRoot) {
  const files = [
    {
      relative: ['yargs', 'build', 'index.cjs'],
      marker: 'pkgUp()',
      re: /function guessVersion\(\)\s*\{[\s\S]*?return obj\.version \|\| 'unknown';\s*\}/,
      replacement: "function guessVersion() {\n        return 'unknown';\n    }"
    },
    {
      relative: ['github', 'lib', 'views', 'git-timings-view.js'],
      marker: 'componentWillReceiveProps(',
      re: /^ {2}componentWillReceiveProps\(/m,
      replacement: '  UNSAFE_componentWillReceiveProps('
    },
    {
      relative: ['github', 'lib', 'atom', 'commands.js'],
      marker: 'componentWillReceiveProps(',
      re: /^ {2}componentWillReceiveProps\(/m,
      replacement: '  UNSAFE_componentWillReceiveProps('
    }
  ];
  for (const file of files) {
    const filePath = path.join(nodeModulesRoot, ...file.relative);
    if (!fs.existsSync(filePath)) {
      continue;
    }
    const contents = fs.readFileSync(filePath, 'utf8');
    if (!contents.includes(file.marker) || file.re.test(contents)) {
      continue;
    }
    const patched = contents.replace(file.re, file.replacement);
    if (patched !== contents) {
      fs.writeFileSync(filePath, patched);
      console.log(`Patched ${file.relative.join('/')} (deprecation warning)`);
    }
  }
}

// atom.io API is permanently dead (301 → sunset page). The notifications
// package fetches atom.io/api/updates and atom.io/api/packages/<name> during
// renderFatalError. Both return non-OK → Promise.reject() → Promise.all in
// notification-element.js rejects → the "Create issue on the X package" click
// handler is never wired up → the button does nothing. Fix: resolve null
// instead of rejecting, add null guards in the callers, and add a ["catch"] on
// the Promise.all so the button always wires up even if something else rejects.
// Also make the is.gd shortener fall back to the long issue URL instead of null
// (shell.openExternal(null) would otherwise do nothing on Linux).
function patchDeadAtomApiNotifications(nodeModulesRoot) {
  const files = [
    {
      relative: ['notifications', 'lib', 'user-utilities.coffee'],
      replacements: [
        [
          '      .then (r) -> if r.ok then r.json() else Promise.reject r.statusCode',
          '      .then (r) -> if r.ok then r.json() else Promise.resolve null'
        ],
        [
          "  checkAtomUpToDate: ->\n    @getLatestAtomData().then (latestAtomData) ->\n      installedVersion = atom.getVersion()?.replace(/-.*$/, '')",
          "  checkAtomUpToDate: ->\n    @getLatestAtomData().then (latestAtomData) ->\n      return null unless latestAtomData?\n      installedVersion = atom.getVersion()?.replace(/-.*$/, '')"
        ],
        [
          '  checkPackageUpToDate: (packageName) ->\n    @getLatestPackageData(packageName).then (latestPackageData) =>\n      installedVersion = @getPackageVersion(packageName)',
          '  checkPackageUpToDate: (packageName) ->\n    @getLatestPackageData(packageName).then (latestPackageData) =>\n      return null unless latestPackageData?\n      installedVersion = @getPackageVersion(packageName)'
        ]
      ]
    },
    {
      relative: ['notifications', 'lib', 'notification-issue.coffee'],
      replacements: [
        [
          '      .then (r) -> r.text()\n      .catch (e) -> null',
          '      .then (r) -> r.text()\n      .catch (e) -> issueUrl'
        ],
        [
          "    repoUrl = 'atom/atom' unless repoUrl?",
          "    repoUrl = 'atomeditor-io/atom' unless repoUrl?"
        ],
        [
          "    repoUrl = 'https://github.com/atom/atom' unless repoUrl?",
          "    repoUrl = 'https://github.com/atomeditor-io/atom' unless repoUrl?"
        ],
        [
          "    repoUrl?.replace(/\\.git$/, '').replace(/^git\\+/, '')",
          "    repoUrl?.replace(/\\.git$/, '').replace(/^git\\+/, '').replace(/^https:\\/\\/github\\.com\\/atom\\/(?=[^/]+\\/?$)/, 'https://github.com/atomeditor-io/')"
        ],
        [
          'https://github.com/atom/.github/blob/master/CODE_OF_CONDUCT.md',
          'https://github.com/atomeditor-io/atom/blob/master/CODE_OF_CONDUCT.md'
        ],
        [
          'The Atom message board is the best place for getting support: https://discuss.atom.io',
          'Discussions is the best place for getting support: https://github.com/atomeditor-io/atom/discussions'
        ],
        [
          "    * Reproduced the problem in Safe Mode: <https://flight-manual.atom.io/hacking-atom/sections/debugging/#using-safe-mode>\n    * Followed all applicable steps in the debugging guide: <https://flight-manual.atom.io/hacking-atom/sections/debugging/>\n    * Checked the FAQs on the message board for common solutions: <https://discuss.atom.io/c/faq>\n    * Checked that your issue isn't already filed: <https://github.com/issues?q=is%3Aissue+user%3Aatom>",
          "    * Reproduced the problem in Safe Mode\n    * Checked that your issue isn't already filed: <https://github.com/atomeditor-io/atom/issues?q=is%3Aissue+user%3Aatomeditor-io>"
        ],
        [
          'an Atom package that provides the described functionality: <https://atom.io/packages>',
          'an Atom package that provides the described functionality: <https://atomeditor.io/packages>'
        ]
      ]
    },
    {
      relative: ['notifications', 'lib', 'notification-element.coffee'],
      replacements: [
        [
          '        return\n    else\n      Promise.resolve()',
          "        return\n      .catch (e) =>\n        fatalNotification.innerHTML += \" You can help by creating an issue. Please explain what actions triggered this error.\"\n        issueButton.addEventListener 'click', (e) =>\n          e.preventDefault()\n          issueButton.classList.add('opening')\n          @issue.getIssueUrlForSystem().then (issueUrl) ->\n            shell.openExternal(issueUrl)\n            issueButton.classList.remove('opening')\n    else\n      Promise.resolve()"
        ],
        ['Create issue on atom/atom', 'Create issue on atomeditor-io/atom']
      ]
    }
  ];
  for (const file of files) {
    const filePath = path.join(nodeModulesRoot, ...file.relative);
    if (!fs.existsSync(filePath)) {
      continue;
    }
    let contents = fs.readFileSync(filePath, 'utf8');
    let anyPatched = false;
    for (const [from, to] of file.replacements) {
      if (!contents.includes(from) || contents.includes(to)) {
        continue;
      }
      contents = contents.split(from).join(to);
      anyPatched = true;
    }
    if (anyPatched) {
      fs.writeFileSync(filePath, contents);
      console.log(
        `Patched ${file.relative.join(
          '/'
        )} (dead atom.io API / create-issue button)`
      );
    }
  }
}

// Electron 20+ defaults the renderer sandbox to ON. The GitHub package's
// In Electron 39, text-buffer Point instances returned by
// HighlightIterator.getPosition() are frozen (Object.freeze). The upstream
// tokenizedLineForRow() mutates end.row/end.column directly, which throws
// "Cannot assign to read only property 'row'" and breaks python
// (TreeSitterLanguageMode) highlighting — every .py file shows zero colors.
// Fix: clone the position before clamping.
function patchTreeSitterFrozenPoint(repositoryRootPath) {
  // In the full bootstrap+build chain this is patched in the repo src/ BEFORE
  // copyAssets() copies it to out/app. In a --no-bootstrap build copyAssets
  // runs first, so also patch the intermediate app copy when it exists.
  const candidates = [
    path.join(repositoryRootPath, 'src', 'tree-sitter-language-mode.js'),
    path.join(CONFIG.intermediateAppPath, 'src', 'tree-sitter-language-mode.js')
  ];
  let patchedAny = false;
  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    let contents = fs.readFileSync(filePath, 'utf8');
    if (contents.includes('// [atom-revival] frozen-point-guard')) continue;
    const oldBlock =
      '    const iterator = this.buildHighlightIterator();\n' +
      '    let start = { row, column: 0 };\n' +
      '    const scopes = iterator.seek(start, row);\n' +
      '    while (true) {\n' +
      '      const end = iterator.getPosition();\n' +
      '      if (end.row > row) {\n' +
      '        end.row = row;\n' +
      '        end.column = lineText.length;\n' +
      '      }';
    const newBlock =
      '    const iterator = this.buildHighlightIterator();\n' +
      '    let start = { row, column: 0 };\n' +
      '    const scopes = iterator.seek(start, row);\n' +
      '    while (true) {\n' +
      '      // [atom-revival] frozen-point-guard: getPosition() may return a frozen Point;\n' +
      '      // clone before mutating to avoid "Cannot assign to read only property".\n' +
      '      let end = iterator.getPosition();\n' +
      '      if (end.row > row) {\n' +
      '        end = { row, column: lineText.length };\n' +
      '      }';
    if (!contents.includes(oldBlock)) continue;
    contents = contents.replace(oldBlock, newBlock);
    fs.writeFileSync(filePath, contents);
    patchedAny = true;
    console.log(
      'Patched tree-sitter-language-mode.js (frozen Point guard):',
      filePath
    );
  }
  return patchedAny;
}

// After tree.edit() (buffer change / checkpoint undo restore) and before the
// next parse finishes, TreeSitterLanguageMode's root tree AND any injection
// layer tree are still truthy objects, but their rootNode getter returns null
// (native node id == 0 = NULL TSNode). Bracket-matcher then calls
// getSyntaxNodeAtPosition on selection change and crashes at
// `tree.rootNode.descendantForIndex(...)` → "Cannot read properties of null
// (reading 'descendantForIndex')" → issue-report form pops up in .py files.
// Fix: guard on tree.rootNode at the _forEachTreeWithRange choke point (covers
// every caller) plus the descendantForIndex access itself.
function patchTreeSitterNullRootNode(repositoryRootPath) {
  const candidates = [
    path.join(repositoryRootPath, 'src', 'tree-sitter-language-mode.js'),
    path.join(CONFIG.intermediateAppPath, 'src', 'tree-sitter-language-mode.js')
  ];
  let patchedAny = false;
  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    let contents = fs.readFileSync(filePath, 'utf8');
    if (contents.includes('// [atom-revival] null-root-node-guard')) continue;
    let changed = false;

    const oldForEachTree =
      '  _forEachTreeWithRange(range, callback) {\n' +
      '    if (this.rootLanguageLayer.tree) {\n' +
      '      callback(this.rootLanguageLayer.tree, this.rootLanguageLayer.grammar);\n' +
      '    }';
    const newForEachTree =
      '  _forEachTreeWithRange(range, callback) {\n' +
      '    // [atom-revival] null-root-node-guard: tree.rootNode is transiently null\n' +
      '    // right after tree.edit() and before the reparse finishes.\n' +
      '    if (this.rootLanguageLayer.tree && this.rootLanguageLayer.tree.rootNode) {\n' +
      '      callback(this.rootLanguageLayer.tree, this.rootLanguageLayer.grammar);\n' +
      '    }';
    if (contents.includes(oldForEachTree)) {
      contents = contents.replace(oldForEachTree, newForEachTree);
      changed = true;
    }

    const oldInjectionTree =
      '      const { tree, grammar } = injectionMarker.languageLayer;\n' +
      '      if (tree) callback(tree, grammar);';
    const newInjectionTree =
      '      const { tree, grammar } = injectionMarker.languageLayer;\n' +
      '      // [atom-revival] null-root-node-guard (injection layer, see above)\n' +
      '      if (tree && tree.rootNode) callback(tree, grammar);';
    if (contents.includes(oldInjectionTree)) {
      contents = contents.replace(oldInjectionTree, newInjectionTree);
      changed = true;
    }

    const oldDescendant =
      '      let node = tree.rootNode.descendantForIndex(startIndex, searchEndIndex);';
    const newDescendant =
      '      // [atom-revival] null-root-node-guard: skip until reparse lands\n' +
      '      let node = tree.rootNode\n' +
      '        ? tree.rootNode.descendantForIndex(startIndex, searchEndIndex)\n' +
      '        : null;';
    if (contents.includes(oldDescendant)) {
      contents = contents.replace(oldDescendant, newDescendant);
      changed = true;
    }

    if (!changed) continue;
    fs.writeFileSync(filePath, contents);
    patchedAny = true;
    console.log(
      'Patched tree-sitter-language-mode.js (null root-node guard):',
      filePath
    );
  }
  return patchedAny;
}

// worker window (node_modules/github/lib/worker-manager.js) creates a
// BrowserWindow with nodeIntegration:true but no sandbox:false, so its
// renderer runs sandboxed and `require`/`process` are undefined inside
// github/lib/renderer.html -> "Uncaught ReferenceError: require is not
// defined" when the GitHub panel starts a git worker. Force the worker
// window out of the sandbox so the renderer can require node modules.
// Electron 14 removed `electron.remote`; a shim in src/electron-shims.js
// still logs a deprecation whenever it is accessed. The bundled github,
// settings-view and tabs packages keep using it, so every startup shows a
// wall of "atom core" deprecations in the cop. Repoint them at
// @electron/remote (already initialized in src/main-process/atom-window.js).
// Runs BEFORE transpileGithubEsm so the ESM import strings still match.
const REMOTE_USAGE_REPLACEMENTS = [
  {
    relative: path.join('github', 'lib', 'models', 'event-logger.js'),
    replacements: [
      [
        "import {remote} from 'electron';",
        "import remote from '@electron/remote';"
      ]
    ]
  },
  {
    relative: path.join('github', 'lib', 'views', 'actionable-review-view.js'),
    replacements: [
      [
        "import {remote, shell} from 'electron';",
        "import {shell} from 'electron';\nimport remote from '@electron/remote';"
      ]
    ]
  },
  {
    relative: path.join('github', 'lib', 'views', 'directory-select.js'),
    replacements: [
      [
        "import {remote} from 'electron';",
        "import remote from '@electron/remote';"
      ]
    ]
  },
  {
    relative: path.join('github', 'lib', 'views', 'git-timings-view.js'),
    replacements: [
      [
        "import {remote} from 'electron';",
        "import remote from '@electron/remote';"
      ]
    ]
  },
  {
    relative: path.join('github', 'lib', 'views', 'staging-view.js'),
    replacements: [
      [
        "import {remote} from 'electron';",
        "import remote from '@electron/remote';"
      ]
    ]
  },
  {
    relative: path.join('github', 'lib', 'controllers', 'conflict-controller.js'),
    replacements: [
      [
        "import {remote} from 'electron';",
        "import remote from '@electron/remote';"
      ]
    ]
  },
  {
    relative: path.join(
      'github',
      'lib',
      'controllers',
      'issueish-list-controller.js'
    ),
    replacements: [
      [
        "import {shell, remote} from 'electron';",
        "import {shell} from 'electron';\nimport remote from '@electron/remote';"
      ]
    ]
  },
  {
    relative: path.join('github', 'lib', 'controllers', 'root-controller.js'),
    replacements: [
      [
        "import {remote} from 'electron';",
        "import remote from '@electron/remote';"
      ]
    ]
  },
  {
    relative: path.join('github', 'lib', 'git-shell-out-strategy.js'),
    replacements: [
      [
        "import {remote} from 'electron';",
        "import remote from '@electron/remote';"
      ]
    ]
  },
  {
    relative: path.join('github', 'lib', 'worker-manager.js'),
    replacements: [
      [
        "import {remote, ipcRenderer as ipc} from 'electron';",
        "import {ipcRenderer as ipc} from 'electron';\nimport remote from '@electron/remote';"
      ]
    ]
  },
  {
    relative: path.join('github', 'lib', 'worker.js'),
    replacements: [
      [
        "const {remote, ipcRenderer: ipc} = require('electron');",
        "const {ipcRenderer: ipc} = require('electron');\nconst remote = require('@electron/remote');"
      ]
    ]
  },
  {
    relative: path.join('settings-view', 'lib', 'uri-handler-panel.js'),
    replacements: [
      ["require('electron').remote.app", "require('@electron/remote').app"]
    ]
  },
  {
    relative: path.join('settings-view', 'lib', 'atom-io-client.coffee'),
    replacements: [
      [
        "{remote} = require 'electron'",
        "remote = require '@electron/remote'"
      ]
    ]
  },
  {
    relative: path.join('tree-view', 'lib', 'root-drag-and-drop.coffee'),
    replacements: [
      [
        "{ipcRenderer, remote} = require 'electron'",
        "{ipcRenderer} = require 'electron'\nremote = require '@electron/remote'"
      ]
    ]
  },
  {
    relative: path.join('devtron', 'out', 'index.js'),
    replacements: [
      [
        "require('electron').remote",
        "require('@electron/remote')"
      ],
      [
        "const remote = electron.remote",
        "const remote = require('@electron/remote')"
      ]
    ]
  },
  {
    relative: path.join('tabs', 'lib', 'tab-bar-view.coffee'),
    replacements: [
      [
        "require('electron').remote.BrowserWindow",
        "require('@electron/remote').BrowserWindow"
      ]
    ]
  }
];

function patchElectronRemoteUsage(nodeModulesRoot) {
  let patchedCount = 0;
  for (const file of REMOTE_USAGE_REPLACEMENTS) {
    const filePath = path.join(nodeModulesRoot, file.relative);
    if (!fs.existsSync(filePath)) {
      continue;
    }
    let contents = fs.readFileSync(filePath, 'utf8');
    let anyPatched = false;
    for (const [from, to] of file.replacements) {
      if (!contents.includes(from) || contents.includes(to)) {
        continue;
      }
      contents = contents.split(from).join(to);
      anyPatched = true;
    }
    if (anyPatched) {
      fs.writeFileSync(filePath, contents);
      console.log(`Patched ${file.relative} (electron.remote → @electron/remote)`);
      patchedCount++;
    }
  }
  return patchedCount;
}

// Deprecation-cop's "Report Issue" and Settings' package links derive from each
// package's `repository` field. Bundled packages still point at the archived
// upstream org (github.com/atom/*); they are maintained in this fork, so repoint
// them at the fork repository. Durable: registry deps are re-fetched on every
// clean install, so this must run at build time.
function patchBundledPackageRepositoryURLs(nodeModulesRoot) {
  let patchedCount = 0;
  if (!fs.existsSync(nodeModulesRoot)) {
    return 0;
  }
  const FORK_URL = 'https://github.com/atomeditor-io/atom';
  const FORK_GIT_URL = `git+${FORK_URL}.git`;
  const UPSTREAM_URL_RE = /^(?:git\+)?https?:\/\/github\.com\/atom\//;
  const rewrite = value => {
    if (typeof value === 'string') {
      if (!UPSTREAM_URL_RE.test(value)) {
        return value;
      }
      return value.startsWith('git+') ? FORK_GIT_URL : FORK_URL;
    }
    if (value && typeof value === 'object') {
      for (const key of ['url', 'web']) {
        if (typeof value[key] === 'string') {
          value[key] = rewrite(value[key]);
        }
      }
    }
    return value;
  };
  for (const entry of fs.readdirSync(nodeModulesRoot, {
    withFileTypes: true
  })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) {
      continue;
    }
    const pkgPath = path.join(nodeModulesRoot, entry.name, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      continue;
    }
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    } catch (e) {
      continue;
    }
    let changed = false;
    for (const field of ['repository', 'bugs', 'homepage']) {
      if (pkg[field] === undefined) {
        continue;
      }
      const before = JSON.stringify(pkg[field]);
      pkg[field] = rewrite(pkg[field]);
      if (JSON.stringify(pkg[field]) !== before) {
        changed = true;
      }
    }
    if (changed) {
      fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
      console.log(`Patched ${entry.name}/package.json (repository → fork)`);
      patchedCount++;
    }
  }
  return patchedCount;
}

function patchGitHubWorkerSandbox(nodeModulesRoot) {
  const filePath = path.join(
    nodeModulesRoot,
    'github',
    'lib',
    'worker-manager.js'
  );
  if (!fs.existsSync(filePath)) {
    return;
  }
  let contents = fs.readFileSync(filePath, 'utf8');
  if (contents.includes('sandbox: false')) {
    return;
  }
  contents = contents
    .split('webPreferences: {nodeIntegration: true, enableRemoteModule: true}')
    .join(
      'webPreferences: {nodeIntegration: true, enableRemoteModule: true, sandbox: false}'
    );
  fs.writeFileSync(filePath, contents);
  console.log('Patched github/lib/worker-manager.js (renderer sandbox: false)');
}

// Newer Electron/Node fs.Stats may omit some of atime/birthtime/ctime/mtime
// (or expose them non-own), so _.pick loses them and tree-view's
// `stats[key].getTime()` crashes -> "Failed to activate the tree-view package"
// on startup. Null-guard the getTime calls (directory.js already did).
function patchTreeViewGetTime(nodeModulesRoot) {
  const files = [
    {
      relative: ['tree-view', 'lib', 'tree-view.coffee'],
      replacements: [
        [
          '          stats[key] = stats[key].getTime()',
          '          stats[key] = stats[key]?.getTime()'
        ]
      ]
    }
  ];
  for (const file of files) {
    const filePath = path.join(nodeModulesRoot, ...file.relative);
    if (!fs.existsSync(filePath)) {
      continue;
    }
    let contents = fs.readFileSync(filePath, 'utf8');
    let anyPatched = false;
    for (const [from, to] of file.replacements) {
      if (!contents.includes(from) || contents.includes(to)) {
        continue;
      }
      contents = contents.split(from).join(to);
      anyPatched = true;
    }
    if (anyPatched) {
      fs.writeFileSync(filePath, contents);
      console.log(
        `Patched ${file.relative.join('/')} (tree-view getTime null guard)`
      );
    }
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
  return (
    fs.existsSync(buildDir) &&
    fs.readdirSync(buildDir).some(f => f.endsWith('.node'))
  );
}

function buildSuperstring() {
  console.log('Rebuilding superstring for Electron');
  childProcess.execFileSync(
    CONFIG.getLocalNpmBinPath(),
    [
      'rebuild',
      '--target=' + CONFIG.appMetadata.electronVersion,
      '--disturl=' +
        (process.env.ATOM_ELECTRON_URL || 'https://electronjs.org/headers'),
      '--arch=x64'
    ],
    {
      env: process.env,
      cwd: path.join(CONFIG.repositoryRootPath, 'node_modules', 'superstring')
    }
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
        if (entry.name === 'node_gyp_bins') {
          gypBins.push(full);
        } else if (entry.name !== '.bin') {
          stack.push([full, depth + 1]);
        }
      }
    }
  }
  for (const dir of gypBins) {
    fs.removeSync(dir);
  }
  if (gypBins.length) {
    console.log('Removed ' + gypBins.length + ' node_gyp_bins dirs');
  }
}

// Electron 39+ (V8 13) removed v8::Object::GetIsolate() and
// v8::Context::GetIsolate(); NAN-era natives use both at init time. Replace
// with the Isolate::GetCurrent() form that is stable across all supported V8
// versions. (info.GetIsolate() on callback info is still fine and untouched.)
function patchRemovedIsolateGetters(nodeModulesRoot) {
  const replacementsByNeedle = [
    [
      'Isolate* isolate = exports->GetIsolate();',
      'Isolate* isolate = v8::Isolate::GetCurrent();'
    ],
    [
      'v8::Isolate* isolate = context->GetIsolate();',
      'v8::Isolate* isolate = v8::Isolate::GetCurrent();'
    ]
  ];
  let patched = [];
  for (const pkg of SHIPPED_NATIVE_PACKAGES) {
    const pkgRoot = path.join(nodeModulesRoot, pkg);
    if (!fs.existsSync(pkgRoot)) continue;
    const stack = [[pkgRoot, 0]];
    while (stack.length) {
      const [dir, depth] = stack.pop();
      if (depth > 5) continue;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'build' || entry.name === 'node_modules') continue;
          stack.push([full, depth + 1]);
          continue;
        }
        if (!/\.(cc|cpp|h|hpp)$/.test(entry.name)) continue;
        let contents = fs.readFileSync(full, 'utf8');
        let changed = false;
        for (const [from, to] of replacementsByNeedle) {
          if (contents.includes(from)) {
            contents = contents.split(from).join(to);
            changed = true;
          }
        }
        if (changed) {
          fs.writeFileSync(full, contents);
          patched.push(path.relative(nodeModulesRoot, full));
        }
      }
    }
  }
  if (patched.length) {
    console.log('Patched removed Isolate getters in: ' + patched.join(', '));
  }
}

function patchGrammarFileTypes(nodeModulesRoot) {
  // [atom-revival] generic safety net: file:-dep packages in packages/language-*
  // must exist in node_modules with their grammars before the asar is packed.
  // npm has been observed to skip syncing some of them on incremental installs.
  const localPackagesDir = path.join(CONFIG.repositoryRootPath, 'packages');
  if (fs.existsSync(localPackagesDir)) {
    for (const entry of fs.readdirSync(localPackagesDir)) {
      if (!entry.startsWith('language-')) continue;
      const srcDir = path.join(localPackagesDir, entry);
      const srcGrammarDir = path.join(srcDir, 'grammars');
      if (!fs.existsSync(srcGrammarDir)) continue;
      const destDir = path.join(nodeModulesRoot, entry);
      let seeded = false;
      for (const grammarFile of fs.readdirSync(srcGrammarDir)) {
        const src = path.join(srcGrammarDir, grammarFile);
        const dest = path.join(destDir, 'grammars', grammarFile);
        if (!fs.existsSync(dest)) {
          fs.ensureDirSync(path.dirname(dest));
          fs.copyFileSync(src, dest);
          seeded = true;
        }
      }
      const srcPkg = path.join(srcDir, 'package.json');
      const destPkg = path.join(destDir, 'package.json');
      if (fs.existsSync(srcPkg) && !fs.existsSync(destPkg)) {
        fs.ensureDirSync(destDir);
        fs.copyFileSync(srcPkg, destPkg);
        seeded = true;
      }
      if (seeded)
        console.log(`patchGrammarFileTypes: seeded ${entry} into node_modules`);
    }
  }
  // [atom-revival] tree-sitter grammars claim fileTypes that TextMate grammars
  // don't; with useTreeSitterParsers=false those extensions would resolve to the
  // Null grammar. Backfill them into the TM grammars (idempotent).
  const targets = [
    {
      file: path.join(
        nodeModulesRoot,
        'language-javascript',
        'grammars',
        'javascript.cson'
      ),
      anchor: /('fileTypes': \[\n)( {2}'js'\n)/,
      insert: "  'jsx'\n"
    },
    {
      file: path.join(
        nodeModulesRoot,
        'language-html',
        'grammars',
        'html.cson'
      ),
      anchor: /('fileTypes': \[\n)( {2}'ejs'\n)/,
      insert: "  'erb'\n"
    },
    {
      file: path.join(
        nodeModulesRoot,
        'language-html',
        'grammars',
        'html.cson'
      ),
      anchor: /( {2}'html'\n)( {2}'kit'\n)/,
      insert: "  'html.ejs'\n  'html.erb'\n"
    }
  ];
  for (const target of targets) {
    if (!fs.existsSync(target.file)) {
      console.warn(`patchGrammarFileTypes: missing ${target.file}`);
      continue;
    }
    const contents = fs.readFileSync(target.file, 'utf8');
    if (!contents.includes(target.insert.trim())) {
      const patched = contents.replace(target.anchor, `$1$2${target.insert}`);
      if (patched === contents) {
        console.warn(
          `patchGrammarFileTypes: anchor not found in ${target.file}`
        );
      } else {
        fs.writeFileSync(target.file, patched);
        console.log(
          `patchGrammarFileTypes: patched ${path.relative(
            nodeModulesRoot,
            target.file
          )} (+ ${target.insert.trim().replace(/\n/g, ' ')})`
        );
      }
    }
  }
  // [atom-revival] language-rust-bundled has no TextMate grammar at all; seed one
  // from the repo package dir so .rs files highlight with useTreeSitterParsers=false.
  const rustSource = path.join(
    CONFIG.repositoryRootPath,
    'packages',
    'language-rust-bundled',
    'grammars',
    'rust.cson'
  );
  const rustDest = path.join(
    nodeModulesRoot,
    'language-rust-bundled',
    'grammars',
    'rust.cson'
  );
  if (fs.existsSync(rustSource) && !fs.existsSync(rustDest)) {
    fs.copyFileSync(rustSource, rustDest);
    console.log(
      'patchGrammarFileTypes: seeded rust.cson into language-rust-bundled'
    );
  }
}

module.exports = function patchNodeModules() {
  const root = path.join(CONFIG.repositoryRootPath, 'node_modules');
  patchElectronRemoteUsage(root);
  patchBundledPackageRepositoryURLs(root);
  transpileGithubEsm(root);
  patchDeprecatedUsage(root);
  patchDeadAtomApiNotifications(root);
  patchGitHubWorkerSandbox(root);
  patchFirstMateScannerLoudGuard(root);
  patchTreeViewGetTime(root);
  patchGrammarFileTypes(root);
  const patched = patchSuperstringSources(root);
  removeNodeGypBins(root);
  if (patched && !superstringIsBuilt(root)) {
    buildSuperstring();
  }
  patchRemovedIsolateGetters(root);
  patchContextAwareSources(root);
  // Clean installs (fingerprint bumped) arrive with NO prebuilt binaries,
  // because apm ci runs with npm_config_ignore_scripts=true to avoid
  // prebuild-install (node-abi can't map modern Electron ABIs) and the
  // spellchecker node-gyp compile (removed V8 GetIsolate). Rebuild every
  // native module the app can load against the Electron target; sources are
  // now context-aware or N-API (both fine to rebuild unconditionally).
  // The tree-sitter grammar bindings also ship in the app and are built from
  // root node_modules (each with its own binding.gyp). Pin the rebuild set to
  // the proven shipped modules instead of scanning blindly for binding.gyp.
  const grammarTargets = [];
  if (fs.existsSync(root)) {
    for (const entry of fs.readdirSync(root)) {
      if (/^tree-sitter-/.test(entry)) {
        grammarTargets.push(entry);
      }
    }
  }
  const targets = Array.from(
    new Set([
      ...SHIPPED_NATIVE_PACKAGES.filter(p => fs.existsSync(path.join(root, p))),
      ...grammarTargets
    ])
  );
  for (const pkg of targets) {
    rebuildNativeForElectron(root, pkg);
    reseedNestedNativeCopies(CONFIG.repositoryRootPath, root, pkg);
  }
  rebuildNestedShippedNatives(root);
  provisionBinaryDependencies(root);
  patchTreeSitterFrozenPoint(CONFIG.repositoryRootPath);
  patchTreeSitterNullRootNode(CONFIG.repositoryRootPath);
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
  syncRebuiltNativesToIntermediate(root);
};

// script/build runs copyAssets() BEFORE patchNodeModules(), so
// CONFIG.intermediateAppPath already holds a snapshot of the tree with
// empty/absent native build output. Mirror every `.node` product rebuilt in
// the tree above into out/app so electron-packager ships working natives.
function syncRebuiltNativesToIntermediate(nodeModulesRoot) {
  const destRoot = path.join(CONFIG.intermediateAppPath, 'node_modules');
  if (!fs.existsSync(destRoot)) return;
  const stack = [nodeModulesRoot];
  let copied = 0;
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!/\.node$/.test(entry.name)) continue;
      const dest = path.join(destRoot, path.relative(nodeModulesRoot, full));
      fs.ensureDirSync(path.dirname(dest));
      fs.copyFileSync(full, dest);
      copied++;
    }
  }
  console.log(
    `Synced ${copied} native binaries into ${CONFIG.intermediateAppPath}`
  );
}

module.exports.scrub = function scrubOutputTree(rootPath) {
  patchElectronRemoteUsage(rootPath);
  patchBundledPackageRepositoryURLs(path.join(rootPath, 'node_modules'));
  transpileGithubEsm(rootPath);
  removeNodeGypBins(rootPath);
};
