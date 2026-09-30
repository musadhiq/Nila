# Nila character assets

`concept-sheet.png` is the master design reference: a young South Indian
girl with long wavy black hair, small red bindi, gold jhumka earrings,
light green kurta. It is kept here for future use.

## States

One 1024px PNG per character state, all generated from the concept sheet
in a consistent 3D animated-film style on plain light backgrounds:

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

## Notes

- These are AI-generated from the user's own concept sheet (user-supplied
  artwork for this project). They are not copied from any third-party
  character or product.
- The current `NilaCharacter` SVG renderer in `src/components/` is the
  Phase-5 placeholder. Wiring the character engine to these images
  (with reduced-motion fallbacks) is scheduled before the first packaged
  build.
