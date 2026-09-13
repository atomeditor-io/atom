/** @babel */
/** @jsx etch.dom **/

import etch from 'etch';

const RELEASES_API_URL =
  'https://api.github.com/repos/tmiland-lab/atom/releases/latest';
const RELEASES_HTML_URL = 'https://github.com/tmiland-lab/atom/releases';

let shell = null;
function getShell() {
  if (shell === null) {
    try {
      shell = require('electron').shell;
    } catch (err) {
      shell = undefined;
    }
  }
  return shell;
}

function formatSize(size) {
  if (!size) return '';
  return `(${(size / 1024 / 1024).toFixed(1)} MB)`;
}

function formatDate(isoDate) {
  try {
    return new Date(isoDate).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  } catch (err) {
    return isoDate;
  }
}

function normalizeMarkdown(markdown) {
  if (!markdown) return '';
  return markdown
    .split('\n')
    .map(line => {
      const heading = line.match(/^(#{1,6})\s+(.*)/);
      if (heading) return heading[2].toUpperCase();
      const bullet = line.match(/^\s*[-*+]\s+(.*)/);
      if (bullet) return `\u2022 ${bullet[1]}`;
      const numbered = line.match(/^\s*(\d+)[.)]\s+(.*)/);
      if (numbered) return `${numbered[1]}. ${numbered[2]}`;
      return line.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1');
    })
    .join('\n');
}

export default class NewsView {
  constructor(props) {
    this.props = props;
    this.state = { status: 'loading', release: null };
    etch.initialize(this);

    this.element.addEventListener('click', event => {
      const link = event.target.closest('a');
      if (link && link.dataset.externalUrl) {
        event.preventDefault();
        this.openExternal(link.dataset.externalUrl);
      } else if (link && link.dataset.event) {
        this.props.reporterProxy.sendEvent(
          `clicked-releases-${link.dataset.event}-link`
        );
      }
    });

    this.fetchRelease();
  }

  async fetchRelease() {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(RELEASES_API_URL, {
        signal: controller.signal,
        headers: { Accept: 'application/vnd.github+json' }
      });
      clearTimeout(timeout);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const release = await response.json();
      this.state = { status: 'ready', release };
    } catch (err) {
      this.state = { status: 'error', error: err };
    }
    if (this.destroyed) return;
    etch.update(this);
  }

  didChangeShowOnStartup() {
    atom.config.set('welcome.showReleasesOnStartup', this.checked);
  }

  update() {}

  destroy() {
    this.destroyed = true;
    return etch.destroy(this);
  }

  openExternal(url) {
    const electronShell = getShell();
    if (electronShell) {
      electronShell.openExternal(url);
    }
  }

  serialize() {
    return {
      deserializer: 'NewsView',
      uri: this.props.uri
    };
  }

  render() {
    return (
      <div className="welcome">
        <div className="welcome-container">
          <header className="welcome-header">
            <svg
              className="welcome-logo"
              width="330px"
              height="68px"
              viewBox="0 0 330 68"
              version="1.1"
            >
              <g
                stroke="none"
                stroke-width="1"
                fill="none"
                fill-rule="evenodd"
              >
                <g transform="translate(2.000000, 1.000000)">
                  <g
                    transform="translate(96.000000, 8.000000)"
                    fill="currentColor"
                  >
                    <path d="M185.498,3.399 C185.498,2.417 186.34,1.573 187.324,1.573 L187.674,1.573 C188.447,1.573 189.01,1.995 189.5,2.628 L208.676,30.862 L227.852,2.628 C228.272,1.995 228.905,1.573 229.676,1.573 L230.028,1.573 C231.01,1.573 231.854,2.417 231.854,3.399 L231.854,49.403 C231.854,50.387 231.01,51.231 230.028,51.231 C229.044,51.231 228.202,50.387 228.202,49.403 L228.202,8.246 L210.151,34.515 C209.729,35.148 209.237,35.428 208.606,35.428 C207.973,35.428 207.481,35.148 207.061,34.515 L189.01,8.246 L189.01,49.475 C189.01,50.457 188.237,51.231 187.254,51.231 C186.27,51.231 185.498,50.458 185.498,49.475 L185.498,3.399 L185.498,3.399 Z" />
                    <path d="M113.086,26.507 L113.086,26.367 C113.086,12.952 122.99,0.941 137.881,0.941 C152.77,0.941 162.533,12.811 162.533,26.225 L162.533,26.367 C162.533,39.782 152.629,51.792 137.74,51.792 C122.85,51.792 113.086,39.923 113.086,26.507 M158.74,26.507 L158.74,26.367 C158.74,14.216 149.89,4.242 137.74,4.242 C125.588,4.242 116.879,14.075 116.879,26.225 L116.879,26.367 C116.879,38.518 125.729,48.491 137.881,48.491 C150.031,48.491 158.74,38.658 158.74,26.507" />
                    <path d="M76.705,5.155 L60.972,5.155 C60.06,5.155 59.287,4.384 59.287,3.469 C59.287,2.556 60.059,1.783 60.972,1.783 L96.092,1.783 C97.004,1.783 97.778,2.555 97.778,3.469 C97.778,4.383 97.005,5.155 96.092,5.155 L80.358,5.155 L80.358,49.405 C80.358,50.387 79.516,51.231 78.532,51.231 C77.55,51.231 76.706,50.387 76.706,49.405 L76.706,5.155 L76.705,5.155 Z" />
                    <path d="M0.291,48.562 L21.291,3.05 C21.783,1.995 22.485,1.292 23.75,1.292 L23.891,1.292 C25.155,1.292 25.858,1.995 26.348,3.05 L47.279,48.421 C47.49,48.843 47.56,49.194 47.56,49.546 C47.56,50.458 46.788,51.231 45.803,51.231 C44.961,51.231 44.329,50.599 43.978,49.826 L38.219,37.183 L9.21,37.183 L3.45,49.897 C3.099,50.739 2.538,51.231 1.694,51.231 C0.781,51.231 0.008,50.529 0.008,49.685 C0.009,49.404 0.08,48.983 0.291,48.562 L0.291,48.562 Z M36.673,33.882 L23.749,5.437 L10.755,33.882 L36.673,33.882 L36.673,33.882 Z" />
                  </g>
                  <g>
                    <path
                      d="M40.363,32.075 C40.874,34.44 39.371,36.77 37.006,37.282 C34.641,37.793 32.311,36.29 31.799,33.925 C31.289,31.56 32.791,29.23 35.156,28.718 C37.521,28.207 39.851,29.71 40.363,32.075"
                      fill="currentColor"
                    />
                    <path
                      d="M48.578,28.615 C56.851,45.587 58.558,61.581 52.288,64.778 C45.822,68.076 33.326,56.521 24.375,38.969 C15.424,21.418 13.409,4.518 19.874,1.221 C22.689,-0.216 26.648,1.166 30.959,4.629"
                      stroke="currentColor"
                      stroke-width="3.08"
                      stroke-linecap="round"
                    />
                    <path
                      d="M7.64,39.45 C2.806,36.94 -0.009,33.915 0.154,30.79 C0.531,23.542 16.787,18.497 36.462,19.52 C56.137,20.544 71.781,27.249 71.404,34.497 C71.241,37.622 68.127,40.338 63.06,42.333"
                      stroke="currentColor"
                      stroke-width="3.08"
                      stroke-linecap="round"
                    />
                    <path
                      d="M28.828,59.354 C23.545,63.168 18.843,64.561 15.902,62.653 C9.814,58.702 13.572,42.102 24.296,25.575 C35.02,9.048 48.649,-1.149 54.736,2.803 C57.566,4.639 58.269,9.208 57.133,15.232"
                      stroke="currentColor"
                      stroke-width="3.08"
                      stroke-linecap="round"
                    />
                  </g>
                </g>
              </g>
            </svg>
            <h1 className="welcome-title">Welcome back to a living Atom</h1>
          </header>

          {this.renderReleases()}

          <section className="welcome-panel">
            <label>
              <input
                className="input-checkbox"
                type="checkbox"
                checked={atom.config.get('welcome.showReleasesOnStartup')}
                onchange={this.didChangeShowOnStartup}
              />
              Show release news when opening Atom
            </label>
          </section>

          <footer className="welcome-footer">
            <a
              href="https://github.com/tmiland-lab/atom"
              dataset={{ event: 'footer-repo' }}
            >
              tmiland-lab/atom
            </a>{' '}
            <span className="text-subtle">×</span>{' '}
            <a
              className="icon icon-octoface"
              href="https://github.com/"
              dataset={{ event: 'footer-octocat' }}
            />
          </footer>
        </div>
      </div>
    );
  }

  renderReleases() {
    const { status, release } = this.state;

    if (status === 'loading') {
      return (
        <section className="welcome-panel">
          <p>
            <span className="loading loading-spinner-small inline-block" />{' '}
            Fetching the latest release…
          </p>
        </section>
      );
    }

    if (status === 'error' || !release) {
      return (
        <section className="welcome-panel">
          <p>Could not reach GitHub to fetch the latest release info.</p>
          <p>
            You can always find the newest builds at{' '}
            <a href={RELEASES_HTML_URL} dataset={{ event: 'releases-page' }}>
              github.com/tmiland-lab/atom/releases
            </a>
            .
          </p>
        </section>
      );
    }

    const assets = (release.assets || []).filter(
      asset => asset && asset.browser_download_url
    );

    return (
      <div>
        <details className="welcome-card" open>
          <summary className="welcome-summary">{release.tag_name}</summary>
          <div className="welcome-detail">
            <p className="welcome-note">
              {release.name ? `${release.name} \u00B7 ` : ''}
              Released {formatDate(release.published_at)}
            </p>
            <p className="welcome-release-body">
              {normalizeMarkdown(release.body)}
            </p>
            {assets.length > 0 && (
              <p className="welcome-note">Download the release:</p>
            )}
            {assets.map((asset, index) => (
              <p>
                <a
                  className="btn btn-primary icon icon-cloud-download"
                  href={asset.browser_download_url}
                  dataset={{
                    externalUrl: asset.browser_download_url,
                    event: `asset-${index}`
                  }}
                >
                  {asset.name} <span className="text-subtle">{formatSize(asset.size)}</span>
                </a>
              </p>
            ))}
            <p>
              <a href={RELEASES_HTML_URL} dataset={{ event: 'all-releases' }}>
                View all releases
              </a>
            </p>
          </div>
        </details>
      </div>
    );
  }

  getURI() {
    return this.props.uri;
  }

  getTitle() {
    return 'Release News';
  }

  isEqual(other) {
    return other instanceof NewsView;
  }
}