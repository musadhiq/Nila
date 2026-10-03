# Nila Refactor — Functionality Baseline Checklist

Derived from a read-only architectural audit of `main` at `77f983b`
(2026-10-03). The refactor must preserve every behavior below. This VM
cannot run the Tauri app or compile Rust, so frontend changes are verified
with `tsc`, `vite build`, and `node --test`; Rust changes are
subtractive-only and hand-reviewed. **Please confirm the starred items on
your machine** (`cargo test`, then `tauri dev` walkthrough) before merging.

## Voice pipeline
- [ ] Say "Hi Nila" → wake pill appears, Nila enters listening state
- [ ] Speak → live transcription appears as pill subtext (throttled partials)
- [ ] Stop speaking → processing state → final command handled
- [ ] Silence → `speech_timeout` path returns to idle, pill clears
- [ ] Empty transcript → Nila asks to repeat (max 2 attempts), then error path
- [ ] After an answer, conversation mode re-arms listening without a new wake word (900ms delay)
- [ ] "Okay Nila" button and × dismiss the conversation explicitly
- [ ] Terminal intents (goodbye, error, UI actions) end conversation mode, pill dismisses after 5s
- [ ] * Errors (STT failure, Jev stall) end the conversation and dismiss — they must NOT start a new listening turn

## Jev
- [ ] "Open Firefox" → Firefox opens, Nila confirms
- [ ] "Remind me to …" → reminder created via Jev
- [ ] "How are you?" / "What is your name?" → conversational reply (no action)
- [ ] "Set a reminder" → reminder editor opens with title prefilled
- [ ] "Show reminders" → reminder list opens
- [ ] "Help" / "what can you do" → Settings → Commands page
- [ ] Ambiguous "cancel my reminder" → opens the list; "cancel that reminder" uses recent context
- [ ] Only one voice command in flight at a time (second is dropped, never queued)

## Reminders
- [ ] Reminder fires at the right time → top-center dock appears with correct expression
- [ ] Done / Snooze pills work; snooze acknowledgement beat plays
- [ ] Quiet hours (22:00–08:00) suppress firing; missed one-time reminders recover on startup
- [ ] System reminders (battery ≤20%, CPU, memory, disk) still fire
- [ ] Pause-all / resume-all from tray and settings
- [ ] Backup export/import round-trips reminders + settings

## Character & dock
- [ ] Idle: subtle breathe, irregular blink, no constant motion
- [ ] Dock appears top-center only for reminders; tray icon otherwise
- [ ] Reminder expressions match context (food→hungry, dismissals→sad/annoyed, etc.)
- [ ] Wake pill never steals window focus

## Settings
- [ ] All 9 pages render; sidebar active item black/white; content fluid with window
- [ ] Language switch (English/Manglish) applies instantly, persists
- [ ] Theme, accent, motion, sound settings apply live
- [ ] Wake-word toggle enables/disables the listener
- [ ] Jev token add/test/remove flow works (token never displayed)
- [ ] About → Author (musadhiq) opens https://github.com/musadhiq in the browser *

## Models
- [ ] Settings → General → Voice models: status, download with progress, delete
- [ ] With no models, a wake shows the "get them in Settings → General" guidance

## Tray & windows
- [ ] Tray menu: Show, New reminder, Pause/Resume, Settings, Autostart, Quit
- [ ] Tray icon dimmed with "starting…" tooltip until the wake listener is ready *
- [ ] Window close → hides to tray (does not quit)
- [ ] Autostart cold boot: mic becomes live without manual intervention *
