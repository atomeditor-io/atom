const { app } = require('electron');
// tmiland-lab fork (E36+): Electron 36 probes GTK4 first and dies mixing it
// with the GTK3 Electron still loads — force the GTK3 path (proven: manual
// --gtk-version=3 resurrects the app; without it the main process aborts on
// any distro with libgtk-4 installed).
app.commandLine.appendSwitch('gtk-version', '3');
// atomeditor.io fork: the original atom.io package API is dead (sunset). Point
// apm (and the settings-view Install pane, which spawns it) at our static,
// GitHub-backed registry. Respect an explicit ATOM_API_URL so users can override.
if (!process.env.ATOM_API_URL) {
  process.env.ATOM_API_URL = 'https://atomeditor.io/api';
}
const nslog = require('nslog');
const path = require('path');
const temp = require('temp');
const parseCommandLine = require('./parse-command-line');
const startCrashReporter = require('../crash-reporter-start');
const getReleaseChannel = require('../get-release-channel');
const atomPaths = require('../atom-paths');
const fs = require('fs');
const CSON = require('season');
const Config = require('../config');
const StartupTime = require('../startup-time');

StartupTime.setStartTime();

module.exports = function start(resourcePath, devResourcePath, startTime) {
  global.shellStartTime = startTime;
  StartupTime.addMarker('main-process:start');

  process.on('uncaughtException', function(error = {}) {
    if (error.message != null) {
      console.log(error.message);
    }

    if (error.stack != null) {
      console.log(error.stack);
    }
  });

  process.on('unhandledRejection', function(error = {}) {
    if (error.message != null) {
      console.log(error.message);
    }

    if (error.stack != null) {
      console.log(error.stack);
    }
  });

  // TodoElectronIssue this should be set to true before Electron 12 - https://github.com/electron/electron/issues/18397
  app.allowRendererProcessReuse = false;

  app.commandLine.appendSwitch('enable-experimental-web-platform-features');

  const args = parseCommandLine(process.argv.slice(1));

  // This must happen after parseCommandLine() because yargs uses console.log
  // to display the usage message.
  const previousConsoleLog = console.log;
  console.log = nslog;

  args.resourcePath = normalizeDriveLetterName(resourcePath);
  args.devResourcePath = normalizeDriveLetterName(devResourcePath);

  atomPaths.setAtomHome(app.getPath('home'));
  atomPaths.setUserData(app);

  const config = getConfig();
  const colorProfile = config.get('core.colorProfile');
  if (colorProfile && colorProfile !== 'default') {
    app.commandLine.appendSwitch('force-color-profile', colorProfile);
  }

  if (handleStartupEventWithSquirrel()) {
    return;
  } else if (args.test && args.mainProcess) {
    app.setPath(
      'userData',
      temp.mkdirSync('atom-user-data-dir-for-main-process-tests')
    );
    console.log = previousConsoleLog;
    app.on('ready', function() {
      const testRunner = require(path.join(
        args.resourcePath,
        'spec/main-process/mocha-test-runner'
      ));
      testRunner(args.pathsToOpen);
    });
    return;
  }

  const releaseChannel = getReleaseChannel(app.getVersion());
  let appUserModelId = 'com.squirrel.atom.' + process.arch;

  // If the release channel is not stable, we append it to the app user model id.
  // This allows having the different release channels as separate items in the taskbar.
  if (releaseChannel !== 'stable') {
    appUserModelId += `-${releaseChannel}`;
  }

  // NB: This prevents Win10 from showing dupe items in the taskbar.
  app.setAppUserModelId(appUserModelId);

  function addPathToOpen(event, pathToOpen) {
    event.preventDefault();
    args.pathsToOpen.push(pathToOpen);
  }

  function addUrlToOpen(event, urlToOpen) {
    event.preventDefault();
    args.urlsToOpen.push(urlToOpen);
  }

  app.on('open-file', addPathToOpen);
  app.on('open-url', addUrlToOpen);
  app.on('will-finish-launching', () =>
    startCrashReporter({
      uploadToServer: config.get('core.telemetryConsent') === 'limited',
      releaseChannel
    })
  );

  if (args.userDataDir != null) {
    app.setPath('userData', args.userDataDir);
  } else if (args.test || args.benchmark || args.benchmarkTest) {
    app.setPath('userData', temp.mkdirSync('atom-test-data'));
  }

  // ---- atomeditor-io fork (single-instance lock) -----------------------------
  // The stock socket handoff (NetWorker open/AtomApplication.openFromSocketPath)
  // has a cold-boot race: a second `atom <file>` fired while the primary is
  // still booting finds no socket yet (the secret file / socket appear only on
  // 'ready', which can be after the crash dialog), so it falls through the
  // client.on('error') handler into createApplication() and TWO processes open
  // the SAME profile. Both then contend for LevelDB's LOCK; the loser dies with
  // the fatal "Could not connect to indexedDB" dialog (state-store.js:31).
  // requestSingleInstanceLock() closes the race atomically: Electron keys the
  // lock to our userData dir (the same dir the profile lives in), so only one
  // process can ever own this profile per launch. The winner forwards the
  // loser's paths to itself via 'second-instance' instead of a second app.
  const ArgParser = require('./parse-command-line');

  // Module-level stash; primary drains it once AtomApplication is up. Survives
  // launches that arrive between the lock acquisition and application.ready.
  const pendingPathsFromSecondInstance = [];

  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  app.on('second-instance', (event, secondArgv, secondWorkingDirectory) => {
    event.preventDefault();
    const secondArgs = ArgParser(secondArgv.slice(1));
    const secondPathsToOpen = secondArgs.pathsToOpen || [];
    const secondUrlsToOpen = secondArgs.urlsToOpen || [];
    const secondNewWindow = secondArgs['new-window'];
    const secondDev = secondArgs['dev'];
    const secondSafe = secondArgs['safe'];

    if (
      secondPathsToOpen.length === 0 &&
      secondUrlsToOpen.length === 0 &&
      !secondNewWindow
    ) {
      return;
    }

    const handoff = {
      pathsToOpen: secondPathsToOpen,
      urlsToOpen: secondUrlsToOpen,
      newWindow: secondNewWindow,
      devMode: secondDev,
      safeMode: secondSafe,
      workingDirectory: secondWorkingDirectory
    };

    if (global.atomApplication) {
      global.atomApplication.openWithOptions(handoff);
    } else {
      pendingPathsFromSecondInstance.push(handoff);
    }
  });

  module.exports.pendingPathsFromSecondInstance = pendingPathsFromSecondInstance;

  StartupTime.addMarker('main-process:electron-onready:start');
  app.on('ready', function() {
    StartupTime.addMarker('main-process:electron-onready:end');
    app.removeListener('open-file', addPathToOpen);
    app.removeListener('open-url', addUrlToOpen);
    const AtomApplication = require(path.join(
      args.resourcePath,
      'src',
      'main-process',
      'atom-application'
    ));
    AtomApplication.open(args).then(() => {
      // Drain 'second-instance' handoffs that arrived while the primary was
      // still booting (before initialize() had assigned global.atomApplication,
      // so the queue could not be routed to openWithOptions yet). global
      // atomApplication is guaranteed to exist once open()'s launch resolved.
      if (pendingPathsFromSecondInstance.length > 0) {
        const drainSecondInstanceHandoffs = async () => {
          for (const handoff of pendingPathsFromSecondInstance.splice(0)) {
            await global.atomApplication.openWithOptions(handoff);
          }
        };

        drainSecondInstanceHandoffs().catch(handoffError => {
          console.error(
            'Error opening paths handed off from a second Atom instance:',
            handoffError
          );
        });
      }
    });
  });
};

function handleStartupEventWithSquirrel() {
  if (process.platform !== 'win32') {
    return false;
  }

  const SquirrelUpdate = require('./squirrel-update');
  const squirrelCommand = process.argv[1];
  return SquirrelUpdate.handleStartupEvent(squirrelCommand);
}

function getConfig() {
  const config = new Config();

  let configFilePath;
  if (fs.existsSync(path.join(process.env.ATOM_HOME, 'config.json'))) {
    configFilePath = path.join(process.env.ATOM_HOME, 'config.json');
  } else if (fs.existsSync(path.join(process.env.ATOM_HOME, 'config.cson'))) {
    configFilePath = path.join(process.env.ATOM_HOME, 'config.cson');
  }

  if (configFilePath) {
    const configFileData = CSON.readFileSync(configFilePath);
    config.resetUserSettings(configFileData);
  }

  return config;
}

function normalizeDriveLetterName(filePath) {
  if (process.platform === 'win32' && filePath) {
    return filePath.replace(
      /^([a-z]):/,
      ([driveLetter]) => driveLetter.toUpperCase() + ':'
    );
  } else {
    return filePath;
  }
}
