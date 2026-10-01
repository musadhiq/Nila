<p align="center">
  <img src="character/nila-logo.png" alt="Nila logo" width="320" />
</p>

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

## Building installable packages

### Download a released build

Every release (`v0.1.0`, `v0.2.0`, …) ships a `.deb` and an `.AppImage`
on the [Releases page](https://github.com/musadhiq/Nila/releases).
Install the `.deb` with:

```sh
sudo apt install ./nila_*.deb
```

Use `apt install ./file.deb` (not `dpkg -i`) so the runtime libraries
(webkit2gtk, ayatana-appindicator, …) are pulled in automatically. This
installs the `nila` binary, a desktop launcher and the tray icon.
Uninstall anytime with `sudo apt remove nila`.

Prefer no install? `chmod +x` the `.AppImage` and run it on any Linux
distribution.

### Build the packages yourself

`npm run tauri build` compiles the app and produces a `.deb` and an
`.AppImage` locally (see `bundle.targets` in `src-tauri/tauri.conf.json`).
The first build takes several minutes; later builds are incremental.

```sh
npm run tauri build
ls src-tauri/target/release/bundle/deb/
sudo apt install ./src-tauri/target/release/bundle/deb/*.deb
```

### Cutting a release

Push a version tag and the `release` workflow
(`.github/workflows/release.yml`) builds both packages on Ubuntu and
attaches them to the GitHub Release:

```sh
git tag v0.2.0
git push origin v0.2.0
```

The tag must look like `v0.2.0` — the workflow stamps that version into
the build so the `.deb` carries it.

## How it works

- **Tray-first** — Nila lives in the top-right menu bar (system tray).
  The floating character window only appears when a reminder is due, or
  when you open it from the tray menu (left-click toggles it; right-click
  shows Show Nila / Settings / Pause-resume / Quit). When a reminder
  fires she glides in from the tray to her spot with a soft chime —
  reduced/off motion just shows her directly.
- **She remembers her spot** — drag the character anywhere and Nila
  returns to that exact position every time (persisted locally, restored
  on launch; falls back to bottom-right if the saved spot is off-screen).
- **Expressive moments** — twelve concept-sheet expressions
  (`character/expressions/`) flash over her state: a surprised gasp and
  a point at the bubble when a reminder fires, sleepy on snooze, proud
  when you mark one done, confused on a bad backup import.
- **Manglish voice, bilingual settings** — Nila speaks Manglish (Malayalam
  in Latin script, e.g. “Vellam kudicho?”). The settings window is fully
  bilingual: pick **English** or **Manglish** on the Language page and the
  whole interface switches immediately, no restart. The tray menu follows
  the same language.
- **Premium settings window** — a calm two-column desktop settings
  experience (General, Reminders, Character, Appearance, Schedule,
  Notifications, Language, About) in a resizable 960×640 window with
  light/dark/system themes, four quiet accent colors, full keyboard
  support and reduced-motion respect. Changes apply instantly — no save
  buttons.
- **Reminder presentation modes** — *Character + bubble* (the classic
  overlay), *Character only* (Nila appears quietly; click her to see the
  reminder), or *System notification* (Nila stays in the tray). Desktop
  notifications can also back up every reminder.
- **Character visibility** — *Always visible* (Nila stays on screen),
  *Only when reminding* (the tray-first default), or *Hidden* (Nila lives
  in the tray; reminders arrive as system notifications).
- **Reminders** — built-in (water, food, break, movement, sleep), custom
  one-time and recurring reminders, snooze (Pinneed), pause, quiet hours
  (default 22:00–08:00), daily limits and cooldowns.
- **Local-first** — SQLite database, JSON import/export, no network needed.

> **GNOME note:** GNOME Shell hides tray icons by default. Install an
> AppIndicator extension (e.g. “AppIndicator and KStatusNotifierItem
> Support”) so Nila's tray icon is visible.

> **Icon note:** Tauri requires the app icon PNG to be RGBA. If the build
> fails with “icon … is not RGBA”, convert it once:
> `python3 -c "from PIL import Image; p='character/idle.png'; Image.open(p).convert('RGBA').save(p)"`

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
