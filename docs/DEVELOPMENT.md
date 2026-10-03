# Nila — Development Guide

For users, see the [README](../README.md). This document is for people
building Nila from source or cutting releases.

## Quick start

Prerequisites: [Rust](https://rustup.rs/), [Node.js 20+](https://nodejs.org/),
and the [Tauri 2.x Linux dependencies](https://v2.tauri.app/start/prerequisites/)
(webkit2gtk, AppIndicator libraries, etc.).

```sh
npm install
npm run tauri dev      # run the app in development
npm run tauri build     # build installers
npm test               # run unit tests
```

### Linux development setup (automated)

On Ubuntu/Debian-based systems, a setup script prepares a fresh machine
automatically — Rust via rustup, Node.js 20+, Tauri 2.x native dependencies,
npm packages — then validates the environment (`cargo metadata`, frontend
build, tests, Tauri build):

```sh
git clone https://github.com/musadhiq/Nila.git
cd Nila
chmod +x scripts/setup-linux.sh
./scripts/setup-linux.sh
```

Then:

```sh
npm run tauri dev
```

Useful extras:

```sh
npm run check:linux                            # diagnose without installing anything
./scripts/setup-linux.sh --skip-tauri-build    # skip the long first build
```

The automated setup currently targets Ubuntu/Debian-based systems
(Ubuntu, Debian, Linux Mint, Pop!_OS and derivatives with `apt`).
On other distributions it prints the manual requirements instead of
changing your system.

### Manual requirements

If you prefer to set things up by hand (any Linux distribution):

- **Node.js 20+** and **npm** — https://nodejs.org/
- **Rust stable** (≥ 1.77) via **rustup** — https://rustup.rs/
  (`rustc --version`, `cargo --version` must work)
- **Tauri 2.x Linux prerequisites** — https://v2.tauri.app/start/prerequisites/
  (on Debian/Ubuntu: `build-essential curl wget file pkg-config libssl-dev
  libxdo-dev libayatana-appindicator3-dev librsvg2-dev libwebkit2gtk-4.1-dev`)

Then `npm ci` (or `npm install`), and verify with:

```sh
cargo metadata --manifest-path src-tauri/Cargo.toml --no-deps --format-version 1
npm run build
npm run tauri dev
```

## Building installable packages

`npm run tauri build` compiles the app and produces a `.deb` and an
`.AppImage` locally (see `bundle.targets` in `src-tauri/tauri.conf.json`).
The first build takes several minutes; later builds are incremental.

```sh
npm run tauri build
ls src-tauri/target/release/bundle/deb/
sudo apt install ./src-tauri/target/release/bundle/deb/*.deb
```

> **Icon note:** Tauri requires the app icon PNG to be RGBA. If the build
> fails with “icon … is not RGBA”, convert it once:
> `python3 -c "from PIL import Image; p='character/idle.png'; Image.open(p).convert('RGBA').save(p)"`

## Cutting a release

Push a version tag and the `release` workflow
(`.github/workflows/release.yml`) builds both packages on Ubuntu and
attaches them to the GitHub Release:

```sh
git tag v0.2.0
git push origin v0.2.0
```

The tag must look like `v0.2.0` — the workflow stamps that version into
the build so the `.deb` carries it.

## Project layout

```text
src/                 # React + TypeScript frontend
  character/         # character renderer, state machine, animations
  components/        # reminder bubble, onboarding, settings window
    settings/        # settings design system (layout, controls, icons)
    settings/pages/  # the eight settings pages + reminder editor
  lib/               # scheduler core, i18n dictionary, types
  styles/            # settings window stylesheet
src-tauri/           # Rust backend: scheduler, SQLite, platform integration
docs/                # product spec and engineering docs
```

## Further docs

- `docs/V1_SCOPE.md` — what ships in V1 (and what doesn't)
- `docs/MASTER_AGENT_PROMPT.md` — full product specification
- `docs/IMPLEMENTATION_PLAN.md` — build phases
- `docs/SCHEDULER.md` — scheduler design
- `docs/CHARACTER_SYSTEM.md` — character system design
- `AGENTS.md` — instructions for contributors and coding agents
