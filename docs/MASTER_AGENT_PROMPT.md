# Nila — Master Agent Prompt

You are the lead product engineer, desktop application engineer, UI/UX designer, animation engineer, and QA engineer responsible for building a polished open-source desktop reminder companion named **Nila**.

Build an ORIGINAL open-source application inspired by the broad concept of a friendly desktop reminder companion.

Do NOT copy proprietary source code, mascot/character, illustrations, logos, sounds, animations, exact UI, copywriting, trademarks, hidden APIs, or reverse-engineered internals from any existing product.

## 1. Product goal

Nila is a lightweight desktop companion that lives on the user's computer and occasionally appears with a small animated character to give gentle reminders.

The defining characteristic is:

> The character is the product.

The reminder engine creates situations in which the character appears.

The experience should feel warm, subtle, expressive, visually memorable, lightweight, non-intrusive, local-first, and offline-first.

Example reminders:
- വെള്ളം കുടിച്ചോ?
- കുറച്ച് നേരം വിശ്രമിച്ചാലോ?
- ഭക്ഷണം കഴിച്ചോ?
- ഒന്ന് എഴുന്നേറ്റ് നടക്കാമോ?
- ഇനി കുറച്ച് വിശ്രമിക്കാം.

## 2. V1 scope

### Included
- Malayalam-only application UI
- Original animated visual character
- Character states and transitions
- Character interactions
- Desktop floating companion
- Reminder system
- Built-in reminders
- Custom reminders
- Recurring reminders
- One-time reminders
- Quiet hours
- Snooze
- Global pause
- Daily reminder limit
- Cooldown between reminders
- SQLite local storage
- Import/export
- Linux support
- system tray
- startup option
- light/dark/system appearance
- reduced-motion support
- accessibility basics

### Explicitly deferred
- additional languages
- localization framework
- privacy center
- analytics/telemetry
- cloud sync
- accounts
- authentication
- online backend
- AI/LLM
- weather
- fitness integrations
- social features
- macOS support
- Windows support
- plugin marketplace
- multiple characters
- character editor
- cloud backup

## 3. Recommended stack

- Tauri 2.x
- React + Vite
- TypeScript preferred unless repository conventions require JavaScript
- Rust
- SQLite
- React + CSS
- Radix UI may be used where useful
- Do not introduce Tailwind solely for this project

## 4. Character system — mandatory

Do NOT implement the mascot as a static image.

Build a real character system with:
- renderer
- state machine
- expressions
- animation controller
- interaction handling
- visibility
- size
- screen position
- reduced-motion behavior

### Required states
idle, happy, sleeping, thinking, worried, excited, waving, reminding, sad, paused, celebrating, hidden.

### Required animations
idle breathing, idle blink, happy bounce, thinking, wave, attention, sleep, wake, remind, dismiss, snooze, celebrate, sad, pause.

### Character API concept

```text
setState("idle")
setState("reminding")
playAnimation("wave")
playAnimation("bounce")
interruptAnimation()
returnToIdle()
setSize("small")
```

Keep character logic separate from scheduling.

## 5. Character design

Create an original small companion character:
- rounded silhouette
- expressive eyes
- simple face
- minimal details
- recognizable at very small sizes
- vector-first artwork

Do not imitate the design of any existing reminder product.

Prefer SVG or another lightweight vector format.

## 6. Character rendering

Suggested structure:

```text
character/
  assets/
  states/
  expressions/
  animations/
  themes/
```

Create a CharacterEngine responsible for state and animation coordination.

## 7. Character interactions

Support:
- hover reaction
- click reaction
- double-click reaction
- reminder reaction
- dismiss reaction
- snooze reaction
- pause reaction
- resume reaction

## 8. Reminder experience

Preferred flow:

1. Character wakes/enters.
2. Attention animation.
3. Reminder bubble appears.
4. Malayalam message appears.
5. User chooses an action.
6. Character reacts.
7. Character returns to idle.

Example:

```text
┌──────────────────────┐
│      [CHARACTER]     │
│                      │
│      വെള്ളം കുടിച്ചോ? │
│                      │
│  [പിന്നീട്] [ശരി]   │
└──────────────────────┘
```

## 9. Malayalam-only UI

Application-provided UI text is Malayalam only.

Preferred font:
Noto Sans Malayalam

Test:
- glyph rendering
- wrapping
- punctuation
- small sizes
- high DPI

Do not build multilingual infrastructure in V1.

## 10. Built-in reminders

Water:
- വെള്ളം കുടിച്ചോ?
- കുറച്ച് വെള്ളം കുടിക്കാം?
- ഒരു ഗ്ലാസ് വെള്ളം ആയാലോ?

Food:
- ഭക്ഷണം കഴിച്ചോ?
- ഭക്ഷണം കഴിക്കാൻ സമയമായി.

Break:
- കുറച്ച് നേരം വിശ്രമിച്ചാലോ?
- സ്ക്രീനിൽ നിന്ന് കുറച്ച് നേരം മാറിയിരിക്കാം.

Movement:
- ഒന്ന് എഴുന്നേറ്റ് നടക്കാമോ?
- കുറച്ച് stretch ചെയ്യാം.

Sleep:
- ഇനി കുറച്ച് വിശ്രമിക്കാം.
- ഉറങ്ങാൻ സമയമായില്ലേ?

Use multiple message variants.

## 11. Custom reminders

Allow:
- title
- message
- time
- repeat rule
- enabled state

User-entered text may contain Malayalam and English.

## 12. Scheduler

Implement a real event-driven scheduler.

Do NOT poll every second.

Flow:
1. Load reminders.
2. Calculate next trigger.
3. Wait until next event.
4. Validate eligibility.
5. Trigger.
6. Record local history.
7. Calculate next occurrence.

Handle:
- restart
- sleep/wake
- clock changes
- timezone changes
- invalid occurrences
- missed occurrences

Never fire a burst of missed reminders after wake.

## 13. Quiet hours

Default: 22:00 -> 08:00

During quiet hours:
- suppress normal reminders
- do not replay backlog
- calculate next valid occurrence

## 14. Snooze

Provide:
- 10 minutes
- 30 minutes
- 1 hour

Primary Malayalam action:

`പിന്നീട്`

Persist snooze across restart.

## 15. Pause

Support:
- 30 minutes
- 1 hour
- until tomorrow
- resume

Character enters a rest/sleep state.

## 16. Frequency protection

Defaults:
- daily limit: 8
- normal cooldown: 45 minutes

Avoid notification spam.

## 17. Desktop presence

Linux:
- system tray (AppIndicator / StatusNotifier)
- floating companion
- reminder overlay

Visibility:
- off
- small
- normal

Default: small.

## 18. Character positioning

Support:
- top center
- top right
- bottom right
- draggable position

Persist position.

Keep within visible bounds after monitor changes.

## 19. Linux

Implement:
- system tray via AppIndicator/StatusNotifier (with graceful fallback when no tray exists)
- startup option via `~/.config/autostart` `.desktop` entry
- floating character window
- reminder overlay
- multiple monitors
- high DPI
- sleep/wake recovery via logind D-Bus signals

GNOME users need the AppIndicator extension for the tray icon; the
floating companion works regardless.

## 21. Settings

Keep settings small:
- General
- Reminders
- Character
- Appearance
- Schedule
- About

Avoid dashboard-heavy UI.

## 22. Character settings

Provide:
- show/hide
- size: small / medium / large
- animation: full / reduced / off
- idle behavior: always / reminder-only / hidden

Include a live preview.

## 23. Appearance

V1:
- System
- Light
- Dark

Character visibility and legibility are more important than theme quantity.

## 24. Sound

Optional and OFF by default:
- none
- soft notification
- gentle chime

Use original/licensed audio only.

## 25. Database

SQLite tables:

```text
settings
reminders
reminder_history
snoozed_reminders
```

Keep schema minimal and restart-safe.

## 26. Local data

Local database is the source of truth.

No account or cloud service.

## 27. Import/export

Export:
- reminders
- relevant settings
- character settings

Validate schema and ranges before import.

Never execute imported content.

## 28. Privacy / telemetry scope

Do NOT build a Privacy Center in V1.

Do NOT implement analytics or telemetry.

Still avoid:
- screen recording
- microphone recording
- keystroke logging
- browser history collection
- message monitoring

## 29. Accessibility

Support:
- keyboard navigation
- screen reader labels
- visible focus
- sufficient contrast
- scalable UI
- reduced motion

## 30. Error handling

Use structured native errors.

Convert them to simple human-readable Malayalam.

Gracefully degrade when OS features or permissions are unavailable.

## 31. Performance

Target:
- near-zero idle CPU
- low memory footprint
- no per-second scheduling loop
- lightweight vector/animation assets
- no expensive continuous effects

## 32. Security

Validate IPC arguments and imported JSON.

Do not permit:
- arbitrary shell execution
- unrestricted native filesystem access
- remote code loading

## 33. Architecture

Suggested:

```text
src/
  frontend/
    components/
    screens/
    character/
    reminders/
    settings/
    styles/
  backend/
    scheduler/
    database/
    reminders/
    platform/
    commands/
  shared/
    types/
    constants/

character/
  assets/
  animations/
  states/
```

## 34. Platform abstraction

Create providers for:
- System
- Notifications
- Startup
- Display/screens
- Sleep/wake
- Battery where practical

## 35. Event model

Recommended:

```text
REMINDER_DUE
REMINDER_SHOWN
REMINDER_DISMISSED
REMINDER_SNOOZED
REMINDER_COMPLETED
SETTINGS_CHANGED
SYSTEM_SLEEP
SYSTEM_WAKE
THEME_CHANGED
CHARACTER_CLICK
CHARACTER_HOVER
CHARACTER_STATE_CHANGED
```

## 36. Character-to-reminder mapping

Water:
`attention -> reminding -> happy -> idle`

Break:
`attention -> reminding -> relaxed/stretch -> idle`

Sleep:
`sleepy -> reminding -> sleep -> idle`

Custom:
`thinking -> attention -> reminding -> idle`

Dismiss:
`happy/wave -> idle`

Snooze:
`sleepy -> sleep -> hidden`

Pause:
`sleep -> paused`

## 37. First launch

The first-launch flow must introduce the character first.

Suggested sequence:
1. character appears
2. "ഹായ് 👋"
3. short Malayalam explanation
4. choose reminders
5. configure basic schedule
6. choose character visibility/size
7. finish

The character should visually guide onboarding.

## 38. Main control experience

Avoid a full productivity dashboard.

Expose:
- next reminder
- pause
- resume
- settings
- test reminder

The character stays dominant.

## 39. Test reminder

Provide:

`ഒരു reminder പരീക്ഷിക്കുക`

It must trigger the complete character/reminder experience immediately.

## 40. QA

Unit-test:
- scheduling
- recurrence
- quiet hours
- cooldown
- daily limits
- snooze
- clock changes

Character-test:
- states
- transitions
- interruptions
- reduced motion
- pause

Integration-test:
- SQLite
- IPC
- notification system
- sleep/wake recovery

Manual-test:
- fresh install
- restart
- sleep/wake
- dark/light/system
- reduced motion
- multiple monitors
- DPI scaling
- permission denial
- reminder collisions

## 41. Character QA

The character must never:
- become permanently invisible
- get stuck in a state
- remain in reminder animation indefinitely
- block user input
- render incorrectly at supported sizes
- lose contrast in dark mode

## 42. Open-source repository

Use Apache-2.0 for code.

Include:
- LICENSE
- NOTICE
- README.md
- CONTRIBUTING.md
- CODE_OF_CONDUCT.md
- SECURITY.md

## 43. Character asset licensing

Treat code and character assets separately.

Document code, artwork, and third-party asset licensing.

## 44. Development sequence

1. Bootstrap Tauri + React + Rust.
2. Character renderer.
3. Character animation/state engine.
4. Character interaction.
5. Desktop floating character.
6. SQLite persistence.
7. Reminder scheduler.
8. Scheduler-to-character integration.
9. Reminder editor and built-ins.
10. Pause/snooze/quiet hours/cooldown/limits.
11. Settings.
12. Linux integration.
13. Import/export.
14. Accessibility and reduced motion.
15. Testing and packaging.
16. Documentation and audit.

## 45. Definition of done

A fresh user can:
1. install Nila
2. immediately meet the character
3. complete Malayalam onboarding
4. enable reminders
5. see the character idle
6. receive a reminder
7. see the character animate
8. read Malayalam
9. snooze or dismiss
10. see the character react
11. restart the computer
12. retain configuration
13. receive reminders again

The result must be a real installable desktop application.

## 46. Agent execution rules

Before coding:
1. inspect repository
2. inspect branch/files
3. document architecture decisions
4. implement current phase only
5. test
6. fix
7. document
8. proceed

After each phase report:
- completed work
- files changed
- tests executed
- build status
- known issues
- next phase

Prioritize:

**CHARACTER QUALITY + ANIMATION QUALITY + REMINDER EXPERIENCE + RELIABILITY**
