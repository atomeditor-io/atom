/** @babel */

import { CompositeDisposable } from 'atom';
import ReporterProxy from './reporter-proxy';

let WelcomeView, GuideView, NewsView;

const NEWS_URI = 'atom://welcome/news';
const WELCOME_URI = 'atom://welcome/welcome';
const GUIDE_URI = 'atom://welcome/guide';

export default class WelcomePackage {
  constructor() {
    this.reporterProxy = new ReporterProxy();
  }

  async activate() {
    this.subscriptions = new CompositeDisposable();

    this.subscriptions.add(
      atom.workspace.addOpener(filePath => {
        if (filePath === NEWS_URI) {
          return this.createNewsView({ uri: NEWS_URI });
        }
      })
    );

    this.subscriptions.add(
      atom.workspace.addOpener(filePath => {
        if (filePath === WELCOME_URI) {
          return this.createWelcomeView({ uri: WELCOME_URI });
        }
      })
    );

    this.subscriptions.add(
      atom.workspace.addOpener(filePath => {
        if (filePath === GUIDE_URI) {
          return this.createGuideView({ uri: GUIDE_URI });
        }
      })
    );

    this.subscriptions.add(
      atom.commands.add('atom-workspace', 'welcome:show', () =>
        this.showWelcome()
      )
    );

    if (atom.config.get('welcome.showOnStartup')) {
      await this.showWelcome();
      this.reporterProxy.sendEvent('show-on-initial-load');
    }

    if (atom.config.get('welcome.showReleasesOnStartup')) {
      await this.showReleases();
      this.reporterProxy.sendEvent('show-releases-on-initial-load');
    }
  }

  showWelcome() {
    return Promise.all([
      atom.workspace.open(WELCOME_URI, { split: 'left' }),
      atom.workspace.open(GUIDE_URI, { split: 'right' })
    ]);
  }

  showReleases() {
    return atom.workspace.open(NEWS_URI, { split: 'left' });
  }

  consumeReporter(reporter) {
    return this.reporterProxy.setReporter(reporter);
  }

  deactivate() {
    this.subscriptions.dispose();
  }

  createNewsView(state) {
    if (NewsView == null) NewsView = require('./news-view');
    return new NewsView({ reporterProxy: this.reporterProxy, ...state });
  }

  createWelcomeView(state) {
    if (WelcomeView == null) WelcomeView = require('./welcome-view');
    return new WelcomeView({ reporterProxy: this.reporterProxy, ...state });
  }

  createGuideView(state) {
    if (GuideView == null) GuideView = require('./guide-view');
    return new GuideView({ reporterProxy: this.reporterProxy, ...state });
  }
}