<!-- original atom/atom banner -->
![Atom](https://user-images.githubusercontent.com/378023/49132477-f4b77680-f31f-11e8-8357-ac6491761c6c.png)

<p align="center">
  <strong>The hackable text editor, revived on modern Electron.</strong>
</p>

<p align="center">
  A pure-lineage fork of the archived <a href="https://github.com/atom/atom">atom/atom</a> <code>v1.63.1</code> —
  same tree, same MIT license, same <code>apm</code> package ecosystem — but running on
  <strong>Electron 38</strong> instead of the dead Electron 11 it shipped with. Every rung of the
  climb is built by CI and released for <strong>Linux</strong>, <strong>macOS</strong>, and <strong>Windows</strong>.
</p>

<p align="center">
  <a href="https://github.com/atomeditor-io/atom/releases/latest">
    <img src="https://img.shields.io/github/v/release/atomeditor-io/atom?sort=semver&label=latest&style=flat-square" alt="Latest release">
  </a>
  <a href="https://github.com/atomeditor-io/atom/actions/workflows/build-deb.yml">
    <img src="https://github.com/atomeditor-io/atom/actions/workflows/build-deb.yml/badge.svg" alt="CI">
  </a>
  <a href="LICENSE.md">
    <img src="https://img.shields.io/github/license/atomeditor-io/atom?style=flat-square" alt="MIT license">
  </a>
  <a href="https://github.com/atomeditor-io/atom/commits/master">
    <img src="https://img.shields.io/github/commit-activity/m/atomeditor-io/atom?style=flat-square" alt="Commit activity">
  </a>
</p>

---

## Why this fork

Upstream Atom was archived on **December 15, 2022**. This project keeps it in active shape for the
millions who installed Atom over the years and never stopped using it — and for anyone who wants a
hackable editor that doesn't need an LLM to figure out.

- **Modern Electron runtime** — Electron was bumped rung-by-rung from 11 all the way to 38, with a
  CI-verified build shipped at every step. See the [rung ladder](#electron-rung-ladder).
- **Pure lineage** — this is the atom/atom tree with *our own* patches, not a rebranded fork. Stock
  Electron, same MIT license, same `apm` package ecosystem.
- **Hardened against decay** — the archived upstream referenced dead atom.io endpoints. The Create
  Issue / notification flow, tree-view, and GitHub integration now point at this project. GTK4 probe
  clashes, V8 API removals, and context-aware native-module walls were all solved along the way.
- **CI-built releases for every OS** — `.deb` and `.rpm` for Linux, a macOS zip, and a Windows
  Squirrel installer. Unsigned, but real and self-hostable.

**Status:** v1.63.1-e38.3 · Atom 1.63.1 on Electron 38 · 97 commits ahead of upstream.

Per-rung release notes: [issue #1](https://github.com/atomeditor-io/atom/issues/1).

## Electron rung ladder

| Base         | Rungs shipped      | Notable work |
|--------------|--------------------|--------------|
| v1.63.1-debian13.1 | Electron 11 baseline | Builds on modern Debian, CI `.deb` |
| e13 → e16    | Electron 13.6 → 16.2 | Context-aware native-module wall solved (E14) |
| e17 → e20    | Electron 17.4 → 20.3 | V8 API removal walls; universal fork discipline |
| e21 → e26    | Electron 21.4 → 26.6 | Memory-cage audit; protocol API migrations |
| e27 → e32    | Electron 27.3 → 32.3 | Node ABI jumps handled automatically |
| e33 → e38    | Electron 33.4 → 38.8 | GTK4 clash fix; Create-Issue/tree-view fixes; macOS/Windows installers |

Every rung is tagged `v1.63.1-eNN.x`, built on GitHub Actions, and released with artifacts for
Linux, macOS, and Windows — so you can pick the Electron version that fits your plugins.

## Install

Grab the newest build from the **[releases page](https://github.com/atomeditor-io/atom/releases/latest)**
— latest = newest Electron.

| Platform | Format | Asset |
|----------|--------|-------|
| Debian / Ubuntu | `.deb` | `atom-amd64-1.63.1-e38.3.deb` |
| Fedora / RHEL-likes | `.rpm` | `atom-x86_64-1.63.1-e38.3.rpm` |
| macOS | `.zip` | `atom-mac-1.63.1-e38.3.zip` (unsigned — right-click → Open) |
| Windows | Squirrel `exe` | `atom-x64-1.63.1-e38.3-setup.exe` (+ `.nupkg` & `RELEASES` for chocolatey-style updates) |

Need a specific Electron rung? Every tagged release on the
[releases page](https://github.com/atomeditor-io/atom/releases) keeps its binaries.

## Packages

The `apm` package ecosystem still works — no central registry required:

```bash
apm install owner/repo
```

Native packages build against the current Electron headers through the patched apm pipeline in this
fork (see the [build docs](docs/building-debian13.md)).

**AI coding support**: [atomeditor-io/atom-ai](https://github.com/atomeditor-io/atom-ai) — a CLI-agent
bridge (opencode / aider / claude / custom), no API keys.

```bash
apm install atomeditor-io/atom-ai
```

## Building from source

Debian 13 recipe (local + CI): [docs/building-debian13.md](docs/building-debian13.md).

Short version — Node 12.22.12 + Python 3.11:

```bash
npm_config_node_gyp=... ./script/bootstrap
./script/build --create-debian-package --create-rpm-package
```

CI (`.github/workflows/build-deb.yml`) does the same on every `v*` tag, plus the macOS and Windows jobs.

## Contributing

Report bugs and feature ideas in [issues](https://github.com/atomeditor-io/atom/issues). This is a
small, focused project — help is very welcome, especially on keeping the rung ladder climbing.

## License

[MIT](LICENSE.md) — upstream Atom license, unchanged.