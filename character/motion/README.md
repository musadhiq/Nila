# Nila — Motion Asset Library (Batches 1–5)

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
| `peek/left/` | 6 | `nila_peek_left_01` … `nila_peek_left_06` |
| `peek/bottom/` | 6 | `nila_peek_bottom_01` … `nila_peek_bottom_06` |
| `peek/top-left/` | 8 | `nila_corner_tl_01` … `nila_corner_tl_08` |
| `peek/top-right/` | 6 | `nila_corner_tr_01` … `nila_corner_tr_06` |
| `peek/bottom-left/` | 6 | `nila_corner_bl_01` … `nila_corner_bl_06` |
| `peek/bottom-right/` | 6 | `nila_corner_br_01` … `nila_corner_br_06` |
| `reminder/` | 12 | `nila_reminder_idle`, `notice`, `look`, `enter`, `settle`, `point`, `wait`, `wait_blink`, `react`, `goodbye`, `retreat_01`, `retreat_02` |
| `interaction/` (batch 4) | 30 | `nila_thumbsup_01…06`, `nila_point_01…06`, `nila_cheer_01…06`, `nila_stretch_01…06`, `nila_drink_01…06` |
| `sleep/` | 6 | `nila_sleep_01` … `nila_sleep_06` |
| `celebration/` | 5 | `nila_celebration_01` … `nila_celebration_05` |
| `peek/top/` (upside-down) | 6 | `nila_hang_upside_01` … `nila_hang_upside_06` |

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
- **peek/left**: mirror of the right-edge peek (pixel-perfect left/right
  symmetry); eyes look right, toward screen center.
- **peek/bottom**: `01` is a sliver of head at the bottom edge; `01 → 06`
  rises Nila into a settled curious peek. Eyes look upward, toward screen
  center, in all frames.
- **corner peeks**: play `01 → N` to lean in, hold the last frame, reverse to
  retreat. Eye direction per corner: top-left looks down-right, top-right
  looks down-left, bottom-left looks up-right, bottom-right looks up-left
  (toward screen center).
- **reminder**: full 10-beat arc in playback order —
  `idle → notice → look → enter → settle → point → wait → (wait_blink) →
  react → goodbye → retreat_01 → retreat_02`.
  Suggested staging: fade/slide Nila in on `idle`, play `notice → look`
  (~150 ms apart), hold `enter → settle`, raise the bubble while holding
  `point` (her hand gestures toward the bubble side, eyes glance that way),
  loop `wait ↔ wait_blink` while the reminder is visible, then on user action
  play `react → goodbye → retreat_01 → retreat_02`. All frames gaze at the
  viewer except `point` (glances toward the bubble). Calm and caring
  throughout — no bouncy easing.
- **thumbs-up**: play `01 → 06` once for approval/confirmation moments.
- **point** (interaction): `01 → 06`, arm extends to gesture at something
  beside her; hold `04 → 05` on the extended beat.
- **cheer**: `01 → 06`, quiet happy clap; loop `03 ↔ 04` for the clap itself.
- **stretch**: `01 → 06`, morning-style overhead stretch; hold `03 → 04`.
- **drink**: `01 → 06`, lifts glass and sips; loop `03 ↔ 04` for the sip hold.
- **sleep**: `01 → 06`, eyes droop to sleep; hold `06` (or loop `05 ↔ 06`
  for soft breathing).
- **celebration**: `01 → 05`, arms shoot up in joy; intentionally 5 frames —
  the generated sheet's sixth cell was glitched and is excluded (see Batch
  4/5 notes).
- **hang upside-down**: `01 → 05` hanging playfully upside down from the top
  bar; `06` flips her upright, still holding the bar. Play `01 → 06` once,
  or loop `02 ↔ 05` for the dangling sway.

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

## Batch 2 notes

- `peek/left` was produced by horizontally mirroring the batch-1 right-edge
  peek frames — the two sides match exactly, which is what symmetric edge
  behavior wants. No regeneration was needed.
- The top-left corner sheet came back with 8 frames instead of 6; all 8 are
  kept (`nila_corner_tl_01 … nila_corner_tl_08`).
- Batch-2 QC: dark-background montage of all 32 frames plus close-up
  inspection of every enclosed-white region the automated scan flagged — all
  flags were legitimate detail (kurta embroidery, eye whites, hair-strand
  highlights/gaps); no background remnants needed clearing.

## Batch 3 notes (peek library complete + reminder sequence)

- `peek/bottom-right` finishes the peek library: all four edges and all four
  corners are now covered.
- The reminder sequence was generated as two 6-frame contact sheets (one
  generation per sheet keeps character/camera/lighting consistent *within*
  each half). Frames are registered within each sheet; the two halves have
  slightly different canvas sizes, which is fine since `point → wait` is a
  natural cut point.
- **Rejected and regenerated**: the first take of the reminder's first half
  came back with a white/cream kurta instead of the reference sage-green —
  an identity deviation per the spec, so it was discarded and regenerated
  with an explicit outfit lock. The rejected sheet is NOT in the deliverable.
- Reminder frames use semantic names (`nila_reminder_idle`,
  `nila_reminder_point`, …) matching the spec's naming examples.
- Batch-3 QC: dark-background montage of all 18 frames plus close-up
  inspection of every enclosed-white region the automated scan flagged — all
  flags were legitimate detail (hair-strand gaps, kurta embroidery); no
  background remnants needed clearing.

## Planned next batches

- Batch 4: `interaction/` (thumbs-up, point, celebrate, stretch, drink)
- Batch 5: `sleep/`, `celebration/`, upside-down hanging variant
- Batch 4: `interaction/` (thumbs-up, point, celebrate, stretch, drink, sleep)
- Batch 5: `sleep/`, `celebration/`, upside-down hanging variant

## Batch 4/5 notes (interaction set, sleep, celebration, upside-down hang)

- 47 new frames: 30 interaction (`thumbsup`, `point`, `cheer`, `stretch`,
  `drink` × 6), 6 `sleep/`, 5 `celebration/`, 6 upside-down hang in
  `peek/top/`. Same split/key/feather/union-crop pipeline
  (`process_batch45.py`).
- **Celebration is intentionally 5 frames**: the generated sheet's sixth cell
  was visually glitched, so it was dropped rather than shipped. The source
  sheet was re-saved as the 5-frame `sheets/media-generation-celebration-seq-5f.png`
  before splitting.
- **Anatomy QC and repairs** (every frame hand/leg/eyebrow-count audited):
  - `interaction/nila_point_05`: a stray hand from the neighboring sheet cell
    bled across the cell boundary at the frame's left edge — removed with a
    skin-tone mask (hair and face untouched).
  - `peek/top/nila_hang_upside_02`: generated with a third arm and a stray
    foot near the bar — both removed via targeted image edit; the frame now
    shows her curled hanging pose with exactly 2 arms and 2 tucked feet.
  - `peek/top/nila_hang_upside_05`: stray foot near the bar removed via
    targeted image edit.
  - `peek/top/nila_hang_upside_06`: generated with 4 hands (two detached
    floating hands on the bar plus her own arms at her sides) — repaired via
    targeted image edit so her own two arms reach up and grip the bar
    (exactly 2 arms, 2 hands).
  - The three repaired upside-down frames were re-keyed and re-registered to
    the sequence with bar-anchored alignment, then all six frames were
    union-cropped together, so the animation plays without jumps.
  - Eyebrows verified single in all frames; no double-brow defects found.
