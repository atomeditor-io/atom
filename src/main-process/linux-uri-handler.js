'use strict';

// atom:// URI-handler registration on Linux.
//
// Electron's app.setAsDefaultProtocolClient() is a no-op on Linux
// (https://github.com/electron/electron/issues/6440), so the atom: scheme is
// registered the freedesktop way instead: a .desktop file that maps
// x-scheme-handler/atom to `<launcher> --uri-handler %u`, plus a default entry
// written straight into the user's mimeapps.list.
//
// Deliberately does not shell out to `xdg-mime`: on an account without
// ~/.config it exits 0 without writing anything, and it cannot express
// "unset". Editing mimeapps.list is what xdg-mime does internally.
//
// Kept free of Electron so it can be unit-tested directly
// (spec/main-process/linux-uri-handler.test.js).

const fs = require('fs');
const os = require('os');
const path = require('path');

function removeSync(target) {
  try {
    if (typeof fs.rmSync === 'function') {
      fs.rmSync(target, { recursive: true, force: true });
    } else if (fs.lstatSync(target).isDirectory()) {
      fs.rmdirSync(target, { recursive: true });
    } else {
      fs.unlinkSync(target);
    }
  } catch (error) {
    // Already gone or not removable: nothing to do.
  }
}

// Atom's URI handler on Linux. Electron's app.setAsDefaultProtocolClient() is
// a no-op there (https://github.com/electron/electron/issues/6440), so we
// register the atom: scheme the XDG way instead: a .desktop file mapping
// x-scheme-handler/atom to `atom --uri-handler %u`, made default by writing the
// association into the user's mimeapps.list. This mirrors the long-standing
// community Linux URI handler for Atom.
const LINUX_URI_SCHEME = 'atom';
const LINUX_DESKTOP_SUFFIX = '-url-handler.desktop';

function linuxApplicationsDirs() {
  const home = process.env.HOME || os.homedir();
  const userApplicationsDir = process.env.XDG_DATA_HOME
    ? path.join(process.env.XDG_DATA_HOME, 'applications')
    : path.join(home, '.local', 'share', 'applications');
  // Honour the XDG base-directory spec: $XDG_DATA_DIRS replaces the default
  // `/usr/local/share:/usr/share`. Scanning the same set as `xdg-mime` matters
  // because we consult that command to detect distro-installed handlers.
  const dataDirs = (process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share')
    .split(':')
    .filter(Boolean)
    .map(dir => path.join(dir, 'applications'));
  return [...new Set([userApplicationsDir, ...dataDirs])];
}

function linuxDesktopFileName() {
  return path.basename(process.execPath) + LINUX_DESKTOP_SUFFIX;
}

// Prefer a handler desktop file installed by the package manager (deb/rpm) for
// this or any Atom channel; fall back to one we own in the user's applications
// directory.
function findLinuxUrlHandlerDesktopFile() {
  const preferredNames = [
    linuxDesktopFileName(),
    'atom' + LINUX_DESKTOP_SUFFIX
  ];
  for (const dir of linuxApplicationsDirs()) {
    for (const name of preferredNames) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  for (const dir of linuxApplicationsDirs()) {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch (error) {
      continue;
    }
    const match = entries.find(entry => entry.endsWith(LINUX_DESKTOP_SUFFIX));
    if (match) return path.join(dir, match);
  }
  return null;
}

function linuxDesktopFileHandlesUris(desktopFileName) {
  if (!desktopFileName) return false;
  for (const dir of linuxApplicationsDirs()) {
    const candidate = path.join(dir, desktopFileName);
    if (!fs.existsSync(candidate)) continue;
    try {
      return /--uri-handler/.test(fs.readFileSync(candidate, 'utf8'));
    } catch (error) {
      return false;
    }
  }
  return false;
}

// The command a .desktop file should launch. Prefer Atom's launcher script
// (`<installDir>/bin/atom`, which sets up the process environment and forwards
// --executed-from), mirroring the desktop file shipped by the deb/rpm packages;
// fall back to the raw executable for source/tarball layouts that lack it.
function linuxLauncherCommand() {
  const executableName = path.basename(process.execPath);
  // Walk up from the binary looking for the launcher script. The deb/rpm and
  // source-install layouts put it at `<prefix>/bin/atom` for a binary at
  // `<prefix>/share/atom/atom`; a checkout can keep it next to the binary.
  let dir = path.dirname(process.execPath);
  for (let depth = 0; depth < 3; depth++) {
    const launcher = path.join(dir, 'bin', executableName);
    if (fs.existsSync(launcher)) {
      return `env ATOM_DISABLE_SHELLING_OUT_FOR_ENVIRONMENT=false "${launcher}"`;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return `"${process.execPath}"`;
}

// Write a user-local handler desktop file pointing at this exact executable.
// Used when no package manager installed one (e.g. running from a tarball or
// from source), so in-app registration still works.
function writeLinuxUrlHandlerDesktopFile() {
  const applicationsDir = linuxApplicationsDirs()[0];
  const desktopFilePath = path.join(applicationsDir, linuxDesktopFileName());
  const contents = [
    '[Desktop Entry]',
    'Name=Atom URL Handler',
    'Comment=Handle atom:// URIs with Atom',
    'GenericName=Text Editor',
    `Exec=${linuxLauncherCommand()} --uri-handler %u`,
    'Icon=atom',
    'Type=Application',
    'Terminal=false',
    'NoDisplay=true',
    'StartupNotify=false',
    'Categories=GTK;Utility;TextEditor;Development;',
    `MimeType=x-scheme-handler/${LINUX_URI_SCHEME};`,
    ''
  ].join('\n');
  fs.mkdirSync(applicationsDir, { recursive: true });
  fs.writeFileSync(desktopFilePath, contents);
  return desktopFilePath;
}

function linuxMimeAppsPath() {
  const configHome =
    process.env.XDG_CONFIG_HOME ||
    path.join(process.env.HOME || os.homedir(), '.config');
  return path.join(configHome, 'mimeapps.list');
}

// Read the two sections of mimeapps.list that decide which handler wins:
// [Default Applications] picks one, and [Removed Associations] suppresses a
// pick inherited from a lower-priority file (a distro-installed mimeapps.list
// or defaults.list).
function readLinuxMimeAppsEntries() {
  const entries = { defaults: {}, removed: {} };
  let contents;
  try {
    contents = fs.readFileSync(linuxMimeAppsPath(), 'utf8');
  } catch (error) {
    return entries;
  }
  let section = '';
  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      section = trimmed;
      continue;
    }
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator);
    const value = trimmed
      .slice(separator + 1)
      .split(';')[0]
      .trim();
    if (section === '[Default Applications]') entries.defaults[key] = value;
    else if (section === '[Removed Associations]') entries.removed[key] = value;
  }
  return entries;
}

function readLinuxMimeAppsLines() {
  try {
    return fs
      .readFileSync(linuxMimeAppsPath(), 'utf8')
      .replace(/\n+$/, '')
      .split('\n');
  } catch (error) {
    return [];
  }
}

function writeLinuxMimeAppsLines(lines) {
  const mimeappsPath = linuxMimeAppsPath();
  fs.mkdirSync(path.dirname(mimeappsPath), { recursive: true });
  fs.writeFileSync(
    mimeappsPath,
    lines.length > 0 ? lines.join('\n') + '\n' : ''
  );
}

// Point x-scheme-handler/atom at `defaultDesktopFile` in [Default
// Applications], or clear it when falsy. Any [Removed Associations] marker for
// the key is cleared when setting and written when clearing, so the in-app
// choice always wins over a distro-provided default.
//
// `xdg-mime default` is deliberately not used: on an account without ~/.config
// it exits 0 without writing anything, and it cannot express "unset". Writing
// mimeapps.list is what xdg-mime does internally, without those limitations.
function writeLinuxMimeAppsScheme({
  defaultDesktopFile = null,
  removedDesktopFile = null
} = {}) {
  const key = `x-scheme-handler/${LINUX_URI_SCHEME}`;
  const managedSections = ['[Default Applications]', '[Removed Associations]'];
  const pending = new Map();
  if (defaultDesktopFile) {
    pending.set('[Default Applications]', `${key}=${defaultDesktopFile}`);
  }
  if (removedDesktopFile) {
    pending.set('[Removed Associations]', `${key}=${removedDesktopFile}`);
  }

  const output = [];
  let section = '';
  const flushPendingForSection = () => {
    const entry = pending.get(section);
    if (entry) {
      output.push(entry);
      pending.delete(section);
    }
  };

  for (const line of readLinuxMimeAppsLines()) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      flushPendingForSection();
      section = trimmed;
      const entry = pending.get(section);
      if (entry) {
        output.push(line, entry);
        pending.delete(section);
      } else {
        output.push(line);
      }
      continue;
    }
    if (
      managedSections.indexOf(section) !== -1 &&
      trimmed.startsWith(`${key}=`)
    ) {
      // Replace the first entry with the requested value (or drop it), and
      // collapse duplicates.
      const entry = pending.get(section);
      if (entry) {
        output.push(entry);
        pending.delete(section);
      }
      continue;
    }
    output.push(line);
  }
  flushPendingForSection();
  // Sections that were absent are appended.
  for (const [name, entry] of pending) output.push(name, entry);
  writeLinuxMimeAppsLines(output);
}

function refreshLinuxDesktopDatabase(applicationsDir) {
  const { execFileSync } = require('child_process');
  try {
    execFileSync('update-desktop-database', [applicationsDir], {
      stdio: 'ignore'
    });
  } catch (error) {
    // Optional: desktop environments pick up new entries without it.
  }
}

function linuxProtocolClientState() {
  const key = `x-scheme-handler/${LINUX_URI_SCHEME}`;
  const { defaults, removed } = readLinuxMimeAppsEntries();
  if (defaults[key]) {
    return {
      registered: linuxDesktopFileHandlesUris(defaults[key]),
      desktopFileName: defaults[key]
    };
  }
  if (removed[key] !== undefined) {
    return { registered: false, desktopFileName: '' };
  }
  // No user-level entry: fall back to xdg-mime, which also sees a default
  // installed system-wide by a distro package.
  const { execFileSync } = require('child_process');
  let desktopFileName = '';
  try {
    desktopFileName = execFileSync('xdg-mime', ['query', 'default', key], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch (error) {
    return { registered: false, desktopFileName: '' };
  }
  return {
    registered: desktopFileName
      ? linuxDesktopFileHandlesUris(desktopFileName)
      : false,
    desktopFileName
  };
}

function setLinuxDefaultProtocolClient() {
  const existing = findLinuxUrlHandlerDesktopFile();
  let desktopFilePath = existing;
  if (
    !desktopFilePath ||
    !linuxDesktopFileHandlesUris(path.basename(desktopFilePath))
  ) {
    desktopFilePath = writeLinuxUrlHandlerDesktopFile();
  }
  const desktopFileName = path.basename(desktopFilePath);
  try {
    writeLinuxMimeAppsScheme({ defaultDesktopFile: desktopFileName });
  } catch (error) {
    return false;
  }
  refreshLinuxDesktopDatabase(path.dirname(desktopFilePath));
  return true;
}

function unsetLinuxDefaultProtocolClient() {
  const previous = linuxProtocolClientState();
  const userDesktopFilePath = path.join(
    linuxApplicationsDirs()[0],
    linuxDesktopFileName()
  );
  if (fs.existsSync(userDesktopFilePath)) {
    removeSync(userDesktopFilePath);
    refreshLinuxDesktopDatabase(path.dirname(userDesktopFilePath));
  }
  try {
    // Drop our own default. If a handler is still registered afterwards it
    // comes from a distro-installed desktop file, so record a [Removed
    // Associations] marker to suppress it as well.
    writeLinuxMimeAppsScheme({
      defaultDesktopFile: null,
      removedDesktopFile: previous.desktopFileName || null
    });
  } catch (error) {
    // Read-only config; nothing more we can do from here.
  }
  return !linuxProtocolClientState().registered;
}

module.exports = {
  // Used by atom-application's IPC handlers.
  isRegistered() {
    return linuxProtocolClientState().registered;
  },
  register() {
    return setLinuxDefaultProtocolClient();
  },
  unregister() {
    return unsetLinuxDefaultProtocolClient();
  },

  // Internals, exported for the spec.
  desktopFileName: linuxDesktopFileName,
  applicationsDirs: linuxApplicationsDirs,
  findDesktopFile: findLinuxUrlHandlerDesktopFile,
  desktopFileHandlesUris: linuxDesktopFileHandlesUris,
  launcherCommand: linuxLauncherCommand,
  writeDesktopFile: writeLinuxUrlHandlerDesktopFile,
  mimeAppsPath: linuxMimeAppsPath,
  readMimeAppsEntries: readLinuxMimeAppsEntries,
  writeMimeAppsScheme: writeLinuxMimeAppsScheme,
  protocolClientState: linuxProtocolClientState,
  refreshDesktopDatabase: refreshLinuxDesktopDatabase
};
