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
