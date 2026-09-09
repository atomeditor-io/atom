# Building Atom 1.63.1 on Debian 13 (trixie)

The upstream build docs predate 2022; this is the verified recipe for modern
Debian (and what our CI does). All fixes are already in this branch.

## System dependencies

    sudo apt-get install -y build-essential git libx11-dev libxext-dev \
      libxkbfile-dev libsecret-1-dev fakeroot

Python: system `python3` (3.13) works for everything except apm's bundled
node-gyp — this branch swaps that for node-gyp 9.4.1 (vendored in
`script/patches/node-gyp`), which is happy on modern Python. Node: pin
**12.22.12** (apm bundles node 12.14.1; building apm's own native deps with a
different ABI breaks at require-time).

## Build

    git clone https://github.com/tmiland-lab/atom && cd atom
    git checkout v1.63.1-debian13.1   # or the debian13-compat branch
    export PATH=/path/to/node12/bin:$PATH
    export ATOM_ELECTRON_URL=https://electronjs.org/headers
    export GYP_DEFINES="openssl_fips= "
    ./script/bootstrap
    ./script/build --create-debian-package

Result: `out/atom-amd64.deb` and a runnable `out/atom-1.63.1-amd64/`.

## What breaks without this branch (and the fixes here)

| Symptom | Cause | Fix in this branch |
| --- | --- | --- |
| Header tarballs fail checksums (`TAR_ENTRY_INVALID`) | `atom.io/download/electron` now serves corrupted/truncated files | `install-apm.js` defaults `ATOM_ELECTRON_URL` to `https://electronjs.org/headers` |
| `gyp` dies with a Python `SyntaxError`/traceback | apm bundles node-gyp 5.1.0, incompatible with modern Python | vendored node-gyp 9.4.1 swapped in during `script/bootstrap` |
| `name 'openssl_fips' is not defined` in binding.gyp | stock Electron headers lack the FIPS variable old binding.gyp files condition on | `GYP_DEFINES="openssl_fips= "` default |
| `uint32_t has not been declared` (superstring) | gcc 14 removed transitive `<cstdint>` includes | `patch-node-modules.js` inserts the include + pre-seeds per-package trees with built natives |
| asar: `file links out of the package` (node_gyp_bins/python3) | node-gyp leaves build-time symlinks in build dirs | scrubbed before packaging and again inside `package-application` |
| npm skips native build scripts after an interrupted install | npm never re-runs scripts for already-extracted packages | rebuild manually: `node-gyp rebuild --target=11.5.0 --disturl=https://electronjs.org/headers` in the module dir |

## Installing packages from GitHub (no atom.io registry)

apm installs packages straight from GitHub — no registry involved:

    apm install tmiland-lab/language-c

Pure-JS packages work with any apm. Native packages additionally need the
recipe above (headers URL + `GYP_DEFINES` + Python 3.11 in PATH); this
branch's apm already carries the disturl and node-gyp fixes.

CI: any tag matching `v*-debian13*` builds a `.deb` via
`.github/workflows/build-deb.yml` and attaches it to the release.
