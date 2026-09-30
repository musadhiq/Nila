# Nila Character System

The character is the primary product differentiator and a mandatory V1 subsystem.

## Goals
- original
- expressive
- recognizable at small sizes
- vector-first
- lightweight
- accessible
- easy to extend

## Architecture

```text
CharacterEngine
  ├── state machine
  ├── expression selection
  ├── animation controller
  ├── interaction handler
  ├── visibility
  ├── size
  └── position

CharacterRenderer
  └── renders current character state

CharacterAssets
  ├── base
  ├── expressions
  └── theme adaptations
```

## States

idle, happy, sleeping, thinking, worried, excited, waving, reminding, sad, paused, celebrating, hidden.

## Required animations

idle-breathe, idle-blink, happy-bounce, thinking, wave, attention, wake, remind, dismiss, snooze, sleep, celebrate, sad.

## Reminder sequence

```text
idle -> wake -> attention -> reminding -> reaction -> idle
```

## Snooze

```text
reminding -> sleepy -> sleep -> hidden
```

## Dismiss

```text
reminding -> happy/wave -> idle
```

## Pause

```text
any state -> sleep -> paused
```

## Interaction

Hover: small visual response.

Click: short reaction.

Double-click: stronger friendly reaction.

Do not make the character move unpredictably.

## Reduced motion

When enabled:
- disable continuous breathing
- reduce bounce
- reduce long transitions
- prefer fades or instant state changes

## Quality review

Review each state at 32, 48, 64, 96, 128, and 256px.

Check silhouette, readability, contrast, clipping, smoothness, and frame consistency.

## Extensibility

Future contributors should be able to add a state, expression, animation, or reaction without changing the scheduler.
