<p align="center">
  <img src="assets/nila-banner.png" alt="Nila — little desktop companion" width="100%" />
</p>

# നില (Nila)

**Your little desktop companion for Linux.**

Nila lives on your desktop as a small animated character who looks after
you — kind reminders to drink water, take a break, eat, move and sleep,
spoken in warm Manglish. No accounts, no cloud, no tracking, no AI in the
cloud. Everything stays on your machine.

> 🗣️ You can even talk to her — say **“Hi Nila”** and ask her to open apps,
> set reminders, and get things done, all with fully on-device voice.

## Features

- **A companion, not a notification** — Nila appears on your desktop with a
  soft chime and expressive little moments: a surprised gasp when a reminder
  fires, sleepy when you snooze, proud when you mark one done.
- **Voice-first** — say “Hi Nila”, then just talk: *“open Firefox”*,
  *“remind me to drink water in 20 minutes”*, *“open my project and launch
  VS Code”*. Speech recognition runs 100% locally; no audio ever leaves
  your computer. (First run downloads the free voice models in
  Settings → General.)
- **Gentle reminders** — built-in water, food, break, movement and sleep
  reminders, plus your own one-time and recurring reminders, with snooze
  (Pinneed), pause and quiet hours (default 22:00–08:00).
- **Manglish voice, bilingual settings** — Nila speaks Manglish (Malayalam
  in Latin script, e.g. “Vellam kudicho?”). The whole interface switches
  instantly between **English** and **Manglish**, no restart needed.
- **Tray-first and polite** — Nila lives in the system tray and only appears
  when there's something to tell you. Drag her anywhere; she remembers her
  spot.
- **Private by design** — local SQLite storage, no network needed, nothing
  uploaded anywhere.

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
2. Say **“Hi Nila”** — on first use she'll point you to Settings → General
   to download the free on-device voice models (one click, ~200 MB).
3. Open **Settings** from the tray menu to tune reminders, voice, character
   and appearance.

## A quick tour

- **Left-click the tray icon** to show/hide Nila; **right-click** for the
  menu (Show Nila, New reminder, Pause/Resume, Settings, Quit).
- **Talk to her** — “Hi Nila, remind me to call home at 6pm”, “Hi Nila,
  open Firefox”, “goodbye” to end the conversation.
- **Reminders** — create them by voice or from the tray menu; snooze,
  mark done, or dismiss right from her bubble.
- **Settings** — General, Reminders, Character, Appearance, Schedule,
  Notifications, Language and AI/Jev pages. Changes apply instantly.

## Privacy

Nila has no accounts, no analytics, no telemetry and no cloud backend.
Reminders live in a local SQLite database on your machine. Voice is
transcribed on-device. That's the whole business model: there isn't one.

## For developers

Building from source, the architecture, and release notes for maintainers
live in [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

## License

All code is Apache-2.0 (see `LICENSE`). The Nila character artwork and
third-party assets keep their own licenses (see `NOTICE`).
See `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` and `SECURITY.md`.
