const { assert } = require('chai');
const SystemThemeWatcher = require('../../src/main-process/system-theme-watcher');

describe('SystemThemeWatcher', () => {
  describe('.parseColorScheme', () => {
    it('parses gdbus portal output', () => {
      assert.equal(
        SystemThemeWatcher.parseColorScheme('(uint32 1,)'),
        'dark'
      );
      assert.equal(
        SystemThemeWatcher.parseColorScheme('(uint32 2,)'),
        'light'
      );
      assert.equal(
        SystemThemeWatcher.parseColorScheme('(uint32 0,)'),
        'light'
      );
    });

    it('parses busctl portal output', () => {
      assert.equal(SystemThemeWatcher.parseColorScheme('v u 1'), 'dark');
      assert.equal(SystemThemeWatcher.parseColorScheme('v u 2'), 'light');
      assert.equal(SystemThemeWatcher.parseColorScheme('v u 0'), 'light');
    });

    it('parses gsettings output', () => {
      assert.equal(
        SystemThemeWatcher.parseColorScheme("'prefer-dark'"),
        'dark'
      );
      assert.equal(
        SystemThemeWatcher.parseColorScheme("'prefer-light'"),
        'light'
      );
      assert.equal(SystemThemeWatcher.parseColorScheme("'default'"), 'light');
    });

    it('returns null for unknown output', () => {
      assert.isNull(SystemThemeWatcher.parseColorScheme(''));
      assert.isNull(SystemThemeWatcher.parseColorScheme(null));
      assert.isNull(SystemThemeWatcher.parseColorScheme('(uint32 9,)'));
    });
  });

  describe('mode changes', () => {
    let watcher, nativeTheme, modeListeners;

    beforeEach(() => {
      modeListeners = [];
      const config = {
        get: () => 'system',
        onDidChange: (key, callback) => {
          modeListeners.push(callback);
          return { dispose: () => {} };
        }
      };
      nativeTheme = { themeSource: 'system' };
      watcher = new SystemThemeWatcher({
        config,
        nativeTheme,
        platform: 'linux',
        intervalMs: 60000,
        execFile: (file, args, options, callback) =>
          callback(null, '(uint32 1,)')
      });
      watcher.start();
    });

    afterEach(() => watcher.dispose());

    it('applies the portal scheme when the mode is system', async () => {
      await watcher.readColorScheme();
      assert.equal(nativeTheme.themeSource, 'dark');
    });

    it('pins the theme source in fixed dark and light modes', () => {
      for (const listener of modeListeners) {
        listener({ newValue: 'dark' });
      }
      assert.equal(nativeTheme.themeSource, 'dark');

      for (const listener of modeListeners) {
        listener({ newValue: 'light' });
      }
      assert.equal(nativeTheme.themeSource, 'light');
    });

    it('restores the system default in manual mode', () => {
      for (const listener of modeListeners) {
        listener({ newValue: 'dark' });
      }
      for (const listener of modeListeners) {
        listener({ newValue: 'manual' });
      }
      assert.equal(nativeTheme.themeSource, 'system');
    });

    it('falls back to the next command when one is unavailable', async () => {
      watcher.command = null;
      const candidates = watcher.commandCandidates();
      let calls = 0;
      watcher.execFile = (file, args, options, callback) => {
        calls++;
        if (file === 'gdbus') return callback(new Error('not installed'));
        if (file === 'busctl') return callback(null, 'v u 1');
        return callback(new Error('unexpected'));
      };
      const scheme = await watcher.readColorScheme();
      assert.equal(scheme, 'dark');
      assert.equal(watcher.command.file, 'busctl');
      assert.isAtLeast(calls, 2);
      assert.equal(candidates.length, 3);
    });

    it('keeps the current source when no command works', async () => {
      await watcher.readColorScheme();
      const sourceBefore = nativeTheme.themeSource;
      watcher.command = null;
      watcher.execFile = (file, args, options, callback) =>
        callback(new Error('not installed'));
      const scheme = await watcher.readColorScheme();
      assert.isNull(scheme);
      assert.equal(nativeTheme.themeSource, sourceBefore);
    });
  });

  describe('on non-linux platforms', () => {
    it('does nothing', () => {
      const nativeTheme = { themeSource: 'system' };
      const watcher = new SystemThemeWatcher({
        config: {
          get: () => 'system',
          onDidChange: () => ({ dispose: () => {} })
        },
        nativeTheme,
        platform: 'win32'
      });
      watcher.start();
      watcher.applyMode('dark');
      assert.equal(nativeTheme.themeSource, 'system');
    });
  });
});
