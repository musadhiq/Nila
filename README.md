# നില (Nila)

A gentle desktop reminder companion for Linux.

Nila lives on your desktop as a small animated character and pops up with
kind Malayalam reminders — drink water, take a break, eat, move, sleep —
without accounts, cloud, tracking, or AI. Everything stays on your machine.

> **V1:** Malayalam-only UI · Linux · original character ·
> local SQLite storage · event-driven scheduler

## Quick start (developers)

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

## How it works

- **Character first** — the animated character is the product. It wakes,
  gets your attention, shows a reminder bubble, reacts, and goes back to idle.
- **Reminders** — built-in (water, food, break, movement, sleep), custom
  one-time and recurring reminders, snooze (പിന്നീട്), pause, quiet hours
  (default 22:00–08:00), daily limits and cooldowns.
- **Local-first** — SQLite database, JSON import/export, no network needed.

## Project layout

```text
src/                 # React + TypeScript frontend
  character/         # character renderer, state machine, animations
  components/        # reminder bubble, settings, onboarding
  lib/               # scheduler core, Malayalam strings, types
src-tauri/           # Rust backend: scheduler, SQLite, platform integration
docs/                # product spec and engineering docs
```

## Docs

- `docs/V1_SCOPE.md` — what ships in V1 (and what doesn't)
- `docs/MASTER_AGENT_PROMPT.md` — full product specification
- `docs/IMPLEMENTATION_PLAN.md` — build phases
- `docs/SCHEDULER.md` — scheduler design
- `docs/CHARACTER_SYSTEM.md` — character system design
- `AGENTS.md` — instructions for contributors and coding agents

## Contributing

See `CONTRIBUTING.md` and `CODE_OF_CONDUCT.md`. All code is Apache-2.0
(see `LICENSE`); character artwork and third-party assets keep their own
licenses (see `NOTICE`).

## Security

See `SECURITY.md` for how to report vulnerabilities.
