# Atom (tmiland-lab revival)

Active fork of [atom/atom](https://github.com/atom/atom) `v1.63.1`, keeping a usable Atom alive on modern Electron — pure lineage (this tree + our patches, stock Electron runtime). Upstream archived Atom in Dec 2022; this fork builds, releases, and climbs Electron rung-by-rung.

Progress is tracked in [atomeditor-io/atom#1](https://github.com/atomeditor-io/atom/issues/1) (one comment per rung with release + CI links).

## Status

Latest: **v1.63.1-e38.1** — Atom 1.63.1 / Electron 38.8.6 ([release](https://github.com/atomeditor-io/atom/releases/tag/v1.63.1-e38.1)).

| Base | Rungs shipped | Notes |
|---|---|---|
| v1.63.1-debian13.1 | Electron 11 baseline | Builds on modern Debian, CI `.deb` |
| e13.1 → e38.1 | Electron 13 → 38 | Every rung CI-built; backports kept green |

Notable walls solved: context-aware natives (E14), V8 API removals (E20), universal fork discipline (apm installs branch HEADs, not lockfile SHAs), GTK4 probe clash (E36, forced `gtk-version 3`). Recent rungs (E36→E38) fixed the dead atom.io API calls in the notifications package and added macOS/Windows installers.

## Installing

Grab the build for your Electron rung from [releases](https://github.com/atomeditor-io/atom/releases) (latest = newest Electron):

- **Linux**: `atom-amd64.deb` (Debian/Ubuntu) or `atom.x86_64.rpm` (Fedora/RHEL-likes).
- **macOS**: `atom-mac.zip` (unsigned — right-click → Open on first launch).
- **Windows**: Squirrel installer (`Setup.exe`, unsigned).

## Packages

No registry — install straight from GitHub: `apm install owner/repo`. Pure-JS packages work out of the box; native packages build against Electron headers via the patched apm (see build doc).

AI coding support: [atomeditor-io/atom-ai](https://github.com/atomeditor-io/atom-ai) (`apm install tmiland-lab/atom-ai`) — CLI-agent bridge (opencode/aider/claude/custom), no API keys.

## Building

Debian 13 recipe (local + CI): [docs/building-debian13.md](docs/building-debian13.md). Short version: Node 12.22.12 + Python 3.11, `script/bootstrap`, `script/build --create-debian-package --create-rpm-package`. CI (`.github/workflows/build-deb.yml`) does the same on every `v*` tag plus mac/Windows jobs.

## License

[MIT](LICENSE.md) (upstream Atom license, unchanged).
