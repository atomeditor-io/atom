const { assert } = require('chai');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LinuxUriHandler = require('../../src/main-process/linux-uri-handler');

describe('LinuxUriHandler', () => {
  let tmpHome;
  let savedEnv;

  const KEYS = [
    'HOME',
    'XDG_CONFIG_HOME',
    'XDG_CONFIG_DIRS',
    'XDG_DATA_HOME',
    'XDG_DATA_DIRS'
  ];

  function hasXdgMime() {
    try {
      childProcess.execFileSync('xdg-mime', ['--version'], { stdio: 'ignore' });
      return true;
    } catch (error) {
      return false;
    }
  }

  function userDesktopPath() {
    return path.join(
      process.env.XDG_DATA_HOME,
      'applications',
      LinuxUriHandler.desktopFileName()
    );
  }

  function mimeAppsText() {
    try {
      return fs.readFileSync(LinuxUriHandler.mimeAppsPath(), 'utf8');
    } catch (error) {
      return '';
    }
  }

  function writeMimeApps(contents) {
    fs.mkdirSync(path.dirname(LinuxUriHandler.mimeAppsPath()), {
      recursive: true
    });
    fs.writeFileSync(LinuxUriHandler.mimeAppsPath(), contents);
  }

  // Returns the body lines of a single mimeapps.list section.
  function section(text, name) {
    let inSection = false;
    return text
      .split('\n')
      .filter(line => {
        if (/^\[.*\]$/.test(line.trim())) {
          inSection = line.trim() === `[${name}]`;
          return false;
        }
        return inSection;
      })
      .join('\n');
  }

  beforeEach(() => {
    savedEnv = {};
    for (const key of KEYS) savedEnv[key] = process.env[key];

    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-uri-handler-'));
    process.env.HOME = tmpHome;
    process.env.XDG_CONFIG_HOME = path.join(tmpHome, 'config');
    process.env.XDG_CONFIG_DIRS = path.join(tmpHome, 'etc-xdg');
    process.env.XDG_DATA_HOME = path.join(tmpHome, 'data');
    // Empty system data dir so only the user-level applications dir is seen.
    process.env.XDG_DATA_DIRS = path.join(tmpHome, 'sys-share');
    fs.mkdirSync(process.env.XDG_DATA_DIRS, { recursive: true });
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('registers on an account with no ~/.config at all', () => {
    assert.isFalse(LinuxUriHandler.isRegistered());

    assert.isTrue(LinuxUriHandler.register());
    assert.isTrue(LinuxUriHandler.isRegistered());

    const desktop = fs.readFileSync(userDesktopPath(), 'utf8');
    assert.match(desktop, /^MimeType=x-scheme-handler\/atom;$/m);
    assert.match(desktop, /--uri-handler %u/);
    assert.match(desktop, /^NoDisplay=true$/m);

    const mime = mimeAppsText();
    assert.match(mime, /^\[Default Applications\]$/m);
    assert.include(mime, `x-scheme-handler/atom=${LinuxUriHandler.desktopFileName()}`);
  });

  it('is idempotent and preserves unrelated mimeapps.list content', () => {
    writeMimeApps(
      [
        '[Added Associations]',
        'text/plain=keep.desktop;',
        '',
        '[Default Applications]',
        'x-scheme-handler/other=other.desktop',
        'x-scheme-handler/atom=stale.desktop',
        'x-scheme-handler/atom=stale2.desktop',
        '',
        '[Removed Associations]',
        'x-scheme-handler/other=nope.desktop',
        ''
      ].join('\n')
    );

    assert.isTrue(LinuxUriHandler.register());
    const text = mimeAppsText();
    assert.include(text, 'text/plain=keep.desktop;');
    assert.include(text, 'x-scheme-handler/other=other.desktop');
    assert.include(text, 'x-scheme-handler/other=nope.desktop');
    assert.notInclude(text, 'stale');
    assert.equal((text.match(/^x-scheme-handler\/atom=/gm) || []).length, 1);
  });

  it('clears a stale [Removed Associations] marker when registering', () => {
    writeMimeApps(
      '[Removed Associations]\nx-scheme-handler/atom=gone.desktop\n'
    );

    LinuxUriHandler.register();
    const text = mimeAppsText();
    assert.notInclude(
      section(text, 'Removed Associations'),
      'x-scheme-handler/atom='
    );
    assert.include(
      section(text, 'Default Applications'),
      'x-scheme-handler/atom='
    );
  });

  it('unregisters by dropping the default and the user desktop file', () => {
    LinuxUriHandler.register();

    assert.isTrue(LinuxUriHandler.unregister());
    assert.isFalse(LinuxUriHandler.isRegistered());

    const text = mimeAppsText();
    assert.notInclude(
      section(text, 'Default Applications'),
      'x-scheme-handler/atom='
    );
    assert.include(
      section(text, 'Removed Associations'),
      'x-scheme-handler/atom='
    );
    assert.isFalse(fs.existsSync(userDesktopPath()));
  });

  it('unregister() suppresses a distro-installed handler', function() {
    if (!hasXdgMime()) this.skip();

    const sysApplications = path.join(process.env.XDG_DATA_DIRS, 'applications');
    fs.mkdirSync(sysApplications, { recursive: true });
    fs.writeFileSync(
      path.join(sysApplications, 'atom-url-handler.desktop'),
      [
        '[Desktop Entry]',
        'Name=Atom URL Handler',
        'Exec=/usr/bin/atom --uri-handler %u',
        'Type=Application',
        'MimeType=x-scheme-handler/atom;',
        ''
      ].join('\n')
    );

    // No user-level entry yet, so "registered" comes from the system handler.
    assert.isTrue(LinuxUriHandler.isRegistered());

    assert.isTrue(LinuxUriHandler.unregister());
    assert.isFalse(LinuxUriHandler.isRegistered());
    assert.match(
      mimeAppsText(),
      /\[Removed Associations\][\s\S]*x-scheme-handler\/atom=/
    );
  });
});
