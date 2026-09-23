const { execFile } = require('child_process');

// On Linux, Electron derives `nativeTheme` from the GTK theme name and does
// not subscribe to the freedesktop settings portal, so `prefers-color-scheme`
// is detected once at startup and never updates when the user switches the
// system between dark and light. This watcher queries the portal's color
// scheme while `core.themeMode` is 'system' and drives
// `nativeTheme.themeSource` so that the renderer's media query stays in sync.
//
// In the fixed 'dark' and 'light' modes the theme source is pinned as well,
// which keeps every `prefers-color-scheme` consumer (e.g. markdown previews)
// consistent with the editor's appearance.
const PORTAL_DEST = 'org.freedesktop.portal.Desktop';
const PORTAL_PATH = '/org/freedesktop/portal/desktop';
const PORTAL_INTERFACE = 'org.freedesktop.portal.Settings';
const APPEARANCE_NAMESPACE = 'org.freedesktop.appearance';
const COLOR_SCHEME_KEY = 'color-scheme';

const POLL_INTERVAL_MS = 3000;
const COMMAND_TIMEOUT_MS = 2000;

module.exports = class SystemThemeWatcher {
  static parseColorScheme(output) {
    if (output == null) return null;

    const text = String(output);
    let match = text.match(/uint32\s+(\d+)/);
    if (match) {
      const value = parseInt(match[1], 10);
      if (value === 1) return 'dark';
      if (value === 2 || value === 0) return 'light';
      return null;
    }

    match = text.match(/(?:^|[\s(])u\s+(\d+)/);
    if (match) {
      const value = parseInt(match[1], 10);
      if (value === 1) return 'dark';
      if (value === 2 || value === 0) return 'light';
      return null;
    }

    if (/prefer-dark/i.test(text)) return 'dark';
    if (/prefer-light|default/i.test(text)) return 'light';
    return null;
  }

  constructor(options = {}) {
    this.config = options.config;
    this.nativeTheme =
      options.nativeTheme || require('electron').nativeTheme;
    this.execFile = options.execFile || execFile;
    this.platform = options.platform || process.platform;
    this.intervalMs = options.intervalMs || POLL_INTERVAL_MS;
    this.disposables = [];
    this.timer = null;
    this.command = null;
    this.lastScheme = null;
  }

  start() {
    if (this.platform !== 'linux') return;
    if (this.started) return;
    this.started = true;

    this.disposables.push(
      this.config.onDidChange('core.themeMode', ({ newValue }) =>
        this.applyMode(newValue)
      )
    );

    this.applyMode(this.config.get('core.themeMode'));
  }

  applyMode(mode) {
    if (!this.started || this.platform !== 'linux') return;

    if (mode === 'dark' || mode === 'light') {
      this.stopPolling();
      this.setThemeSource(mode);
    } else if (mode === 'system') {
      this.startPolling();
      this.poll();
    } else {
      this.stopPolling();
      this.setThemeSource('system');
    }
  }

  startPolling() {
    if (this.timer != null) return;
    this.timer = setInterval(() => this.poll(), this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stopPolling() {
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  poll() {
    this.readColorScheme().then(scheme => {
      if (scheme != null && scheme !== this.lastScheme) {
        this.lastScheme = scheme;
        this.setThemeSource(scheme);
      }
    });
  }

  setThemeSource(source) {
    if (this.nativeTheme.themeSource !== source) {
      this.nativeTheme.themeSource = source;
    }
  }

  async readColorScheme() {
    const commands = this.command ? [this.command] : this.commandCandidates();
    for (const command of commands) {
      const output = await this.run(command);
      if (output != null) {
        this.command = command;
        return SystemThemeWatcher.parseColorScheme(output);
      }
    }
    this.command = null;
    return null;
  }

  commandCandidates() {
    return [
      {
        file: 'gdbus',
        args: [
          'call',
          '--session',
          '--dest',
          PORTAL_DEST,
          '--object-path',
          PORTAL_PATH,
          '--method',
          `${PORTAL_INTERFACE}.ReadOne`,
          APPEARANCE_NAMESPACE,
          COLOR_SCHEME_KEY
        ]
      },
      {
        file: 'busctl',
        args: [
          '--user',
          'call',
          PORTAL_DEST,
          PORTAL_PATH,
          PORTAL_INTERFACE,
          'ReadOne',
          'ss',
          APPEARANCE_NAMESPACE,
          COLOR_SCHEME_KEY
        ]
      },
      {
        file: 'gsettings',
        args: ['get', 'org.gnome.desktop.interface', 'color-scheme']
      }
    ];
  }

  run(command) {
    return new Promise(resolve => {
      this.execFile(
        command.file,
        command.args,
        { timeout: COMMAND_TIMEOUT_MS },
        (error, stdout) => {
          if (error || stdout == null) {
            resolve(null);
          } else {
            resolve(String(stdout));
          }
        }
      );
    });
  }

  dispose() {
    this.stopPolling();
    for (const disposable of this.disposables) {
      if (typeof disposable.dispose === 'function') disposable.dispose();
    }
    this.disposables = [];
    this.started = false;
  }
};
