const { CompositeDisposable, Disposable } = require('event-kit');

const MODES = ['manual', 'system', 'dark', 'light'];

// Extended: Applies the UI and syntax themes configured for the current
// `core.themeMode` ('manual', 'system', 'dark' or 'light').
//
// In 'system' mode the manager follows the operating system's dark or light
// appearance via the `prefers-color-scheme` media query and swaps the
// `core.themes` pair automatically whenever the system switches.
module.exports = class AutoThemeManager {
  constructor({ config, window }) {
    this.config = config;
    this.disposables = new CompositeDisposable();
    this.lastMode = null;
    this.darkMediaQuery = null;

    if (window && typeof window.matchMedia === 'function') {
      this.darkMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    }

    this.disposables.add(
      this.config.observe('core.themeMode', mode => {
        this.migrateCurrentThemesOnModeChange(mode);
        if (MODES.includes(mode)) this.lastMode = mode;
        this.apply();
      })
    );

    for (const key of [
      'core.uiThemeDark',
      'core.syntaxThemeDark',
      'core.uiThemeLight',
      'core.syntaxThemeLight'
    ]) {
      this.disposables.add(
        this.config.observe(key, () => {
          this.apply();
        })
      );
    }

    if (this.darkMediaQuery) {
      const onChange = () => {
        this.apply();
      };
      if (typeof this.darkMediaQuery.addEventListener === 'function') {
        this.darkMediaQuery.addEventListener('change', onChange);
        this.disposables.add(
          new Disposable(() => {
            this.darkMediaQuery.removeEventListener('change', onChange);
          })
        );
      } else if (typeof this.darkMediaQuery.addListener === 'function') {
        this.darkMediaQuery.addListener(onChange);
        this.disposables.add(
          new Disposable(() => {
            this.darkMediaQuery.removeListener(onChange);
          })
        );
      }
    }
  }

  dispose() {
    this.disposables.dispose();
  }

  // Returns the configured mode ('manual', 'system', 'dark' or 'light').
  getMode() {
    const mode = this.config.get('core.themeMode');
    return MODES.includes(mode) ? mode : 'manual';
  }

  // Returns true/false when the dark or light theme pair is active, or null
  // when the mode is 'manual' and no automatic selection applies.
  isDark() {
    const mode = this.getMode();
    if (mode === 'dark') return true;
    if (mode === 'light') return false;
    if (mode === 'system') {
      if (this.darkMediaQuery) return this.darkMediaQuery.matches;
      return false;
    }
    return null;
  }

  // Returns the [uiTheme, syntaxTheme] pair for the current mode, or null in
  // 'manual' mode.
  getThemeNames() {
    const dark = this.isDark();
    if (dark === null) return null;
    if (dark) {
      return [
        this.config.get('core.uiThemeDark'),
        this.config.get('core.syntaxThemeDark')
      ];
    }
    return [
      this.config.get('core.uiThemeLight'),
      this.config.get('core.syntaxThemeLight')
    ];
  }

  // Applies the pair matching the current mode by writing `core.themes`.
  // Does nothing in 'manual' mode or when the pair is already active.
  apply() {
    const themeNames = this.getThemeNames();
    if (!themeNames) return;
    const current = this.config.get('core.themes');
    if (
      Array.isArray(current) &&
      current.length === 2 &&
      current[0] === themeNames[0] &&
      current[1] === themeNames[1]
    ) {
      return;
    }
    this.config.set('core.themes', themeNames);
  }

  // When switching from 'manual' to an automatic mode, seed the matching
  // dark/light pair from the currently active themes (when their names
  // clearly indicate dark or light) so the user's selection is preserved.
  migrateCurrentThemesOnModeChange(mode) {
    if (this.lastMode !== 'manual' || mode === 'manual') return;
    const current = this.config.get('core.themes');
    if (!Array.isArray(current) || current.length < 2) return;
    const joined = current.join(' ');
    const isDark = /\bdark\b|\bdark-/i.test(joined);
    const isLight = /\blight\b|\blight-/i.test(joined);
    if (isDark && !isLight) {
      if (this.config.get('core.uiThemeDark') !== current[0]) {
        this.config.set('core.uiThemeDark', current[0]);
      }
      if (this.config.get('core.syntaxThemeDark') !== current[1]) {
        this.config.set('core.syntaxThemeDark', current[1]);
      }
    } else if (isLight && !isDark) {
      if (this.config.get('core.uiThemeLight') !== current[0]) {
        this.config.set('core.uiThemeLight', current[0]);
      }
      if (this.config.get('core.syntaxThemeLight') !== current[1]) {
        this.config.set('core.syntaxThemeLight', current[1]);
      }
    }
  }
};
