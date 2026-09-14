# Atom — the hackable text editor, revived

[![Latest release](https://img.shields.io/github/v/release/atomeditor-io/atom?sort=semver&label=release)](https://github.com/atomeditor-io/atom/releases/latest)
[![CI](https://github.com/atomeditor-io/atom/actions/workflows/build-deb.yml/badge.svg)](https://github.com/atomeditor-io/atom/actions/workflows/build-deb.yml)
[![License](https://img.shields.io/github/license/atomeditor-io/atom)](LICENSE.md)

A maintained, pure-lineage fork of the archived [atom/atom](https://github.com/atom/atom) `v1.63.1` —
the classic hackable text editor, kept alive on a **modern Electron** runtime instead of the dead Electron 11 it shipped with.

**Atom is the text editor that reads the hackable, tool-building, memory-pager-friendly, all-text philosophy and makes it a daily driver again.**

Status: **v1.63.1-e38.3** — Atom 1.63.1 on Electron 38 · 97 commits ahead of upstream · CI-built binaries for Linux, macOS, and Windows.

---

## Why this fork

Upstream Atom was archived in December 2022. This project keeps it in active shape for people who
installed Atom years ago and never stopped using it, and for everyone who wants a hackable editor that
isn't an Electron behemoth *yet*.

What we do here:

- **Modern Electron runtime** — Electron has been bumped rung-by-rung from 11 all the way to 38, shipping
  a CI-verified build every step of the way (see the [rung ladder](#electron-rung-ladder)).
- **Pure lineage** — this is the atom/atom tree with *our own* patches, not a rebranded fork. Stock
  Electron, same MIT license, same `apm` package ecosystem.
- **Fixed against decay** — the archived app referenced dead atom.io endpoints; the Create Issue /
  notification flow, tree-view, and GitHub integration now point at this project. GTK4 probe clashes,
  V8 API removals, and context-aware native-module walls were all solved along the way.
- **CI-built releases for every OS** — .deb and .rpm for Linux, a macOS zip, and a Windows Squirrel
  installer, all unsigned but real.

Progress and per-rung notes live in [issue #1](https://github.com/atomeditor-io/atom/issues/1).

## Electron rung ladder

Latest: **v1.63.1-e38.3** ([release](https://github.com/atomeditor-io/atom/releases/latest)).

| Base | Rungs shipped | Notable work |
|---|---|---|
| v1.63.1-debian13.1 | Electron 11 baseline | Builds on modern Debian, CI `.deb` |
| e13 → e16 | Electron 13.6 → 16.2 | Context-aware native-module wall solved (E14) |
| e17 → e20 | Electron 17.4 → 20.3 | V8 API removal walls; universal fork discipline |
| e21 → e26 | Electron 21.4 → 26.6 | Memory-cage audit; protocol API migrations |
| e27 → e32 | Electron 27.3 → 32.3 | Node ABI jumps handled automatically |
| e33 → e38 | Electron 33.4 → 38.8 | GTK4 clash fix; Create-Issue/tree-view fixes; macOS/Windows installers |

Every rung is tagged `v1.63.1-eNN.x`, built on GitHub Actions, and released with artifacts for
Linux, macOS, and Windows.

## Install

Grab the newest build from the [releases page](https://github.com/atomeditor-io/atom/releases/latest).
Latest = newest Electron.

- **Linux (Debian/Ubuntu)**: `atom-amd64-1.63.1-e38.3.deb`
- **Linux (Fedora/RHEL-likes)**: `atom-x86_64-1.63.1-e38.3.rpm`
- **macOS**: `atom-mac-1.63.1-e38.3.zip` (unsigned — right-click → Open on first launch)
- **Windows**: `atom-x64-1.63.1-e38.3-setup.exe` (unsigned Squirrel installer; a full `.nupkg` + `RELEASES` are also shipped for chocolatey-style updates)

Need a specific Electron rung? Every tagged release in the [releases page](https://github.com/atomeditor-io/atom/releases)
keeps its binaries.

## Packages

The `apm` package ecosystem still works — no central registry needed:

```bash
apm install owner/repo
```

Native packages build against the current Electron headers through the patched apm pipeline in this
fork (see the [build docs](docs/building-debian13.md)).

**AI coding support**: [atomeditor-io/atom-ai](https://github.com/atomeditor-io/atom-ai) — a CLI-agent
bridge (opencode / aider / claude / custom), no API keys. Install with:

```bash
apm install atomeditor-io/atom-ai
```

## Building from source

Debian 13 recipe (local + CI): [docs/building-debian13.md](docs/building-debian13.md).

Short version: Node 12.22.12 + Python 3.11, then

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