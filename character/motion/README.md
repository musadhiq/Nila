# Nila — Motion Asset Library (Batch 1)

Animation-ready transparent PNG frames generated from the character reference
sheet (`character/states/concept-sheet.png`, the single source of truth).
Every sequence was generated as one contact sheet (one consistent character,
camera, and lighting setup) and then split locally; all frames **within one
sequence share the same canvas size and registration**, so they can be played
back as-is.

## Contents

| Group | Frames | Files |
|---|---|---|
| `idle/` | 4 | `nila_idle_01`, `nila_idle_02`, `nila_blink`, `nila_idle_03` |
| `interaction/` | 6 | `nila_wave_01` … `nila_wave_06` |
| `peek/right/` | 6 | `nila_peek_right_01` … `nila_peek_right_06` |
| `peek/top/` | 5 | `nila_hang_top_01` … `nila_hang_top_05` |

`sheets/` keeps the original generated contact sheets (regeneration source).

## Frame guides

- **idle**: loop `nila_idle_01 → nila_idle_02 → nila_idle_01`, insert
  `nila_blink` every few seconds, `nila_idle_03` is a warmer-smile variant.
- **wave**: play `01 → 06` once (~8–10 fps) for greetings and reminder hellos.
- **peek/right**: `01` is almost fully hidden (a sliver of hair at the right
  edge — the "hidden" beat); play `01 → 06` to peek in, hold `06`, reverse to
  retreat. Eyes look left, toward screen center, per the eye-direction rules.
- **peek/top**: `01` is hands gripping the top edge only; `01 → 05` drops Nila
  into the hanging pose. Eyes look downward toward the viewer.

## Processing

White backgrounds were keyed with border-aware masking, thin card-border
removal, feathered alpha, and foreground decontamination; enclosed background
pockets (painted white inside hair loops / between arms) were cleared by hand.
Verified on dark backgrounds — no white halo.

## Design decisions

- The `peek/top` frames keep the dark top bar Nila grips: it matches the
  reference sheet's hanging visual language and reads as the screen edge when
  the window sits at the top of the display. A bar-less variant can be
  generated on request.
- Character identity (face, bindi, jhumka earrings, green floral kurta, hair)
  was checked frame-by-frame against the reference sheet.

## Planned next batches

- Batch 2: `peek/left`, `peek/bottom`, corner peeks (`top-left`, `top-right`, `bottom-left`, `bottom-right`)
- Batch 3: `reminder/` sequence (attention → point at bubble → wait → done)
- Batch 4: `interaction/` (thumbs-up, point, celebrate, stretch, drink, sleep)
- Batch 5: `sleep/`, `celebration/`, upside-down hanging variant
