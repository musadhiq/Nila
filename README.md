<p align="center">
  <img src="assets/nila-banner.webp" alt="Nila — little desktop companion" width="100%" />
</p>

# Nila

**Your little desktop companion for Linux.**

Nila lives in your system tray as a small animated friend who looks after
you — gentle reminders to drink water, take a break, eat, move and sleep,
written in warm Manglish. No accounts, no cloud, no tracking, no AI.
Everything stays on your machine.

> 👋 Say **“Hi Nila”** and she'll pop up to wave hello with a little
> chime — then slip back into the tray. That's all the wake word does:
> a hello, nothing more.

## Features

- **A companion, not a notification** — when a reminder is due, Nila
  appears at the top of your screen with a soft chime and an expressive
  little moment: sleepy when you snooze, proud when you mark one done.
- **Gentle reminders** — built-in water, food, break, movement and sleep
  reminders, plus your own one-time and recurring reminders, with snooze,
  pause and quiet hours (default 22:00–08:00).
- **Manglish reminders, bilingual settings** — reminder messages are
  written in Manglish (Malayalam in Latin script, e.g. “Vellam kudicho?”).
  The whole interface switches instantly between **English** and
  **Manglish**, no restart needed.
- **Tray-first and polite** — Nila lives in the system tray and only
  appears when there's something to tell you, or when you say hi.
- **Private by design** — local SQLite storage, no network needed,
  nothing uploaded anywhere. There is no AI, no voice recognition, and
  no listening beyond the wake word itself.

## Install

### From a release (recommended)

Every release ships a `.deb` and an `.AppImage` on the
[Releases page](https://github.com/musadhiq/Nila/releases).

**Debian / Ubuntu / Mint / Pop!_OS:**

```sh
sudo apt install ./nila_*.deb
```

Use `apt install ./file.deb` (not `dpkg -i`) so the required system
libraries are pulled in automatically. This installs the `nila` app, a
launcher entry and the tray icon. Uninstall anytime with
`sudo apt remove nila`.

**Any other Linux distribution:** download the `.AppImage`, make it
executable (`chmod +x Nila-*.AppImage`) and run it — no installation needed.

> **GNOME users:** GNOME Shell hides tray icons by default. Install the
> “AppIndicator and KStatusNotifierItem Support” extension so Nila's tray
> icon is visible.

### First run

1. Launch **Nila** from your app menu.
2. Walk through the short welcome setup.
3. Open **Settings** from the tray menu to tune reminders, the wake word,
   character and appearance.

## A quick tour

- **Left-click the tray icon** to show/hide Nila; **right-click** for the
  menu (Show Nila, New reminder, Pause/Resume, Settings, Quit).
- **Say “Hi Nila”** — she waves hello with a chime, then hides again.
- **Reminders** — create them from the tray menu (“New reminder”);
  snooze, mark done, or dismiss right from the notification.
- **Settings** — Welcome, General, Nila, Reminders, Appearance,
  Accessibility and About pages. Changes apply instantly.

## Privacy

Nila has no accounts, no analytics, no telemetry, no AI and no cloud
backend. Reminders live in a local SQLite database on your machine.
The wake word is detected on-device; no audio is recorded or sent
anywhere. That's the whole business model: there isn't one.

## For developers

Building from source, the architecture, and release notes for maintainers
live in [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

## License

All code is Apache-2.0 (see `LICENSE`). The Nila character artwork and
third-party assets keep their own licenses (see `NOTICE`).
See `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` and `SECURITY.md`.
