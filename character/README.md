# Nila character assets

`states/concept-sheet.png` is the master design reference: a young South
Indian girl with long wavy black hair, small red bindi, gold jhumka
earrings, light green kurta. It is kept here for future use.

## States

`states/` holds one 1024px PNG per character state, all generated from
the concept sheet in a consistent 3D animated-film style on plain light
backgrounds:

| File | State | Engine mapping |
|---|---|---|
| `idle.png` | idle | `idle` |
| `happy.png` | happy | `happy` |
| `waving.png` | waving | `greeting` |
| `reminding.png` | reminding | `reminding` |
| `sleeping.png` | sleeping | `sleeping` |
| `thinking.png` | thinking | `thinking` |
| `worried.png` | worried | `worried` |
| `excited.png` | excited | `celebrating` (small win) / `excited` |
| `sad.png` | sad | `sad` / `missed` |
| `paused.png` | paused | `paused` / `snoozed` |
| `celebrating.png` | celebrating | `celebrating` |

## Expressions

`expressions/` holds the remaining concept-sheet expressions: momentary
faces and gestures flashed *over* the current engine state (they are not
engine states themselves). Wired via `CharacterEngine.showExpression()` /
`clearExpression()` — see `src/character/expressions.ts` for the manifest.

| File | Expression | Used for |
|---|---|---|
| `surprised.png` | surprised | reminder fires — the attention beat |
| `point.png` | point | follows surprised — points at the reminder bubble |
| `sleepy.png` | sleepy | reminder snoozed |
| `proud.png` | proud | reminder marked done |
| `confused.png` | confused | backup import failed |
| `idea.png` | idea | reserved — e.g. a reminder was just created |
| `curious.png` | curious | reserved — idle variety |
| `playful.png` | playful | reserved — idle variety / easter eggs |
| `facepalm.png` | facepalm | reserved — missed-reminder beat |
| `thumbs-up.png` | thumbs-up | reserved — encouragement moments |
| `explain.png` | explain | reserved — onboarding / help beats |
| `rest-chin.png` | rest-chin | reserved — idle variety |

All generated from the concept sheet in the same 3D animated-film style
(plain light backgrounds, face centered for the circular crop).

## Notes

- These are AI-generated from the user's own concept sheet (user-supplied
  artwork for this project). They are not copied from any third-party
  character or product.
- `src/character/NilaCharacter.tsx` renders these images (one PNG per
  engine state, expressions overlaid), with reduced-motion fallbacks.
