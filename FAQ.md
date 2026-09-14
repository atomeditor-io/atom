# Frequently Asked Questions

## What is this project?

This is the community-run continuation of **Atom** — the long-lived editor from
GitHub that was sunset and archived. We keep the codebase alive, patch it to run
on modern operating systems and up-to-date Electron, and ship installable
packages. It is **not** affiliated with GitHub or GitHub, Inc.

## Is Atom dead / unsupported?

The upstream GitHub project is archived and receives no updates. **This fork
is actively maintained** and ships regular builds — see the
[Releases](https://github.com/atomeditor-io/atom/releases). The upstream
package registry, update servers, and `atom.io` API were shut down; this fork
already redirects those internals to its own infrastructure.

## Where do I download Atom?

From the [Releases page](https://github.com/atomeditor-io/atom/releases) —
pick the `.deb`/`.rpm` for Linux, the `.zip` for macOS, or the `.exe` installer
for Windows. Prefer the newest tagged build.

## How do I install on Linux?

```sh
sudo dpkg -i atom-amd64-*.deb        # Debian/Ubuntu
sudo apt-get install -f              # fix any missing deps
```

or for RPM-based distributions:

```sh
sudo rpm -i atom-x86_64-*.rpm
```

## How do I install on macOS?

Unzip `atom-mac-*.zip` and drag the `Atom.app` bundle into `Applications`.
On Apple Silicon, the build runs under Rosetta 2 (x64) — make sure Rosetta is
installed.

## How do I install on Windows?

Run the `atom-x64-*-setup.exe` installer — it installs Atom and registers the
`atom`, `apm`, and `code` style command-line helpers.

## I found a bug — what do I do?

Report it via **Help → Report Issue** (or
[open an issue](https://github.com/atomeditor-io/atom/issues/new)). The issue
form guides you through the environment and reproduction details we need
(build tag, OS, display server, log output).

Before filing, try reproducing with community packages disabled:

```sh
atom --safe
```

and, if rendering looks wrong, tell us whether you are on **X11 or Wayland**
(`echo $XDG_SESSION_TYPE`).

## Can I use packages/plugins from the old atom.io registry?

Most packages that existed on the `atom.io` package registry have been mirrored
into the community registry used by this fork's `apm`. Search inside Atom via
**Settings → Install**, or use `apm install <package-name>`. Packages that were
abandoned or never mirrored may not be available.

## Why so few packages? / Why is my favorite package missing?

The old registry was shut down at sunset; not every package was mirrored. This
fork restores the *core editor experience* first. If a package matters to you,
open an issue and we can prioritize mirroring it.

## Does it auto-update?

Linux/macOS release channels that pointed at the dead `atom.io` update servers
were disabled. Windows uses the bundled Squirrel updater. Always grab the newest
build from the Releases page — subscribe to the repo for notifications of new
tags.

## Can I build Atom myself?

Yes. The
[build instructions](https://github.com/atomeditor-io/atom/wiki) cover
Docker and native builds. The build needs Node 12 tooling and the pinned
Electron version.

## License?

MIT — see [LICENSE.md](LICENSE.md). Code contributions are welcome via pull
requests; see [CONTRIBUTING.md](CONTRIBUTING.md).

## Who is behind this?

A small community effort, coordinated through
[atomeditor-io](https://github.com/atomeditor-io). Questions and ideas belong
in [Discussions](https://github.com/atomeditor-io/atom/discussions).