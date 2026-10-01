// motionManifest.ts — the Nila motion-asset manifest.
//
// PNG-free on purpose: it describes every animation sequence (ordered
// frames + per-frame timing) without importing any image, so node --test
// can import it. URL resolution and preloading live in motionAssets.ts
// (Vite-only); frame advancement lives in engine.ts / useFramePlayback.
//
// Asset source of truth: character/motion/ (committed PNGs). Frames
// within one sequence share a canvas size and registration, so they can
// be played back-to-back with a stable bottom-center anchor.

export interface FrameDef {
  /** Asset key: the PNG basename without extension, e.g. "nila_wave_03". */
  key: string;
  /** How long this frame stays on screen, in milliseconds. */
  ms: number;
}

export type SequenceLoop = "none" | "loop" | "pingpong";

export interface FrameAnchor {
  /** Horizontal anchor inside the normalized render stage. */
  x: "left" | "center" | "right";
  /** Vertical anchor inside the normalized render stage. */
  y: "top" | "center" | "bottom";
}

export interface SequenceDef {
  name: string;
  frames: FrameDef[];
  loop: SequenceLoop;
  /**
   * When true and loop is "none", the last frame stays on screen after
   * the sequence ends (peek holds, reminder settle) instead of clearing.
   */
  holdLast?: boolean;
  /**
   * Stable anchor for every frame of this sequence. Peek frames are
   * edge-anchored (a right-peek sliver must hug the right edge of the
   * stage); everything else is bottom-center.
   */
  anchor?: FrameAnchor;
}

/** Shorthand: numbered frames `stem_01..stem_NN` with per-frame durations. */
function numbered(
  stem: string,
  count: number,
  ms: number[] | number,
): FrameDef[] {
  const out: FrameDef[] = [];
  for (let i = 1; i <= count; i++) {
    const key = `${stem}_${String(i).padStart(2, "0")}`;
    out.push({ key, ms: Array.isArray(ms) ? ms[i - 1] : ms });
  }
  return out;
}

/**
 * Enter timing: fast beginning, soft settle (spec section 6). The first
 * frames flash by, the last ones linger so the motion lands gently.
 */
const ENTER_MS = [70, 85, 105, 135, 165, 200, 220, 240];
/** Exit timing: the reverse — starts settled, hurries away at the end. */
const EXIT_MS = [240, 220, 200, 165, 135, 105, 85, 70];

function enterFrames(stem: string, count: number): FrameDef[] {
  return numbered(stem, count, ENTER_MS.slice(0, count));
}

function exitFrames(stem: string, count: number): FrameDef[] {
  // Reversed frame order with exit pacing.
  const frames = numbered(stem, count, 0).reverse();
  return frames.map((f, i) => ({ ...f, ms: EXIT_MS[i] ?? 90 }));
}

const CENTER_BOTTOM: FrameAnchor = { x: "center", y: "bottom" };

export const MOTION_SEQUENCES: Record<string, SequenceDef> = {  // -- Idle micro-animation: subtle breathing loop. Blink is injected
  // -- separately at randomized 3.5-7s intervals (see nextBlinkDelayMs).
  idle: {
    name: "idle",
    frames: [
      { key: "nila_idle_01", ms: 1100 },
      { key: "nila_idle_02", ms: 1100 },
    ],
    loop: "loop",
    anchor: CENTER_BOTTOM,
  },

  // -- Greeting wave: out and back once, then the engine fires
  // -- onSequenceEnd so the caller can return to idle.
  wave: {
    name: "wave",
    frames: numbered("nila_wave", 6, 110),
    loop: "pingpong",
    anchor: CENTER_BOTTOM,
  },

  // -- Reminder arc (matches the 10-beat reminder sheet + retreat).
  "reminder-enter": {
    name: "reminder-enter",
    frames: [
      { key: "nila_reminder_notice", ms: 380 },
      { key: "nila_reminder_look", ms: 380 },
      { key: "nila_reminder_enter", ms: 130 },
      { key: "nila_reminder_settle", ms: 220 },
    ],
    loop: "none",
    holdLast: true,
    anchor: CENTER_BOTTOM,
  },
  "reminder-wait": {
    name: "reminder-wait",
    frames: [
      { key: "nila_reminder_wait", ms: 1500 },
      { key: "nila_reminder_wait_blink", ms: 170 },
    ],
    loop: "loop",
    anchor: CENTER_BOTTOM,
  },
  "reminder-react": {
    name: "reminder-react",
    frames: [
      { key: "nila_reminder_react", ms: 700 },
      { key: "nila_reminder_goodbye", ms: 850 },
    ],
    loop: "none",
    holdLast: true,
    anchor: CENTER_BOTTOM,
  },
  "reminder-retreat": {
    name: "reminder-retreat",
    frames: [
      { key: "nila_reminder_retreat_01", ms: 170 },
      { key: "nila_reminder_retreat_02", ms: 170 },
    ],
    loop: "none",
    anchor: CENTER_BOTTOM,
  },
  // Snooze acknowledgement: an understanding look, then retreat.
  "snooze-ack": {
    name: "snooze-ack",
    frames: [
      { key: "nila_reminder_look", ms: 550 },
      { key: "nila_reminder_settle", ms: 450 },
    ],
    loop: "none",
    holdLast: true,
    anchor: CENTER_BOTTOM,
  },

  // -- Interaction set (batch 4).
  thumbsup: {
    name: "thumbsup",
    frames: numbered("nila_thumbsup", 6, 150),
    loop: "none",
    holdLast: true,
    anchor: CENTER_BOTTOM,
  },
  point: {
    name: "point",
    frames: numbered("nila_point", 6, 130),
    loop: "none",
    holdLast: true,
    anchor: CENTER_BOTTOM,
  },
  cheer: {
    name: "cheer",
    frames: numbered("nila_cheer", 6, 140),
    loop: "none",
    anchor: CENTER_BOTTOM,
  },
  stretch: {
    name: "stretch",
    frames: numbered("nila_stretch", 6, 210),
    loop: "none",
    holdLast: true,
    anchor: CENTER_BOTTOM,
  },
  drink: {
    name: "drink",
    frames: numbered("nila_drink", 6, 230),
    loop: "none",
    holdLast: true,
    anchor: CENTER_BOTTOM,
  },

  // -- Rest.
  sleep: {
    name: "sleep",
    frames: numbered("nila_sleep", 6, 650),
    loop: "loop",
    anchor: CENTER_BOTTOM,
  },

  // -- Celebration: intentionally 5 frames (the 6th source cell was
  // -- glitched and dropped at generation time).
  celebration: {
    name: "celebration",
    frames: numbered("nila_celebration", 5, 160),
    loop: "none",
    holdLast: true,
    anchor: CENTER_BOTTOM,
  },

  // -- Edge peeks (enter + exit pairs). Anchors hug the edge she peeks
  // -- from so the sliver frames sit against the window edge.
  "peek-right": {
    name: "peek-right",
    frames: enterFrames("nila_peek_right", 6),
    loop: "none",
    holdLast: true,
    anchor: { x: "right", y: "bottom" },
  },
  "peek-right-exit": {
    name: "peek-right-exit",
    frames: exitFrames("nila_peek_right", 6),
    loop: "none",
    anchor: { x: "right", y: "bottom" },
  },
  "peek-left": {
    name: "peek-left",
    frames: enterFrames("nila_peek_left", 6),
    loop: "none",
    holdLast: true,
    anchor: { x: "left", y: "bottom" },
  },
  "peek-left-exit": {
    name: "peek-left-exit",
    frames: exitFrames("nila_peek_left", 6),
    loop: "none",
    anchor: { x: "left", y: "bottom" },
  },
  "peek-bottom": {
    name: "peek-bottom",
    frames: enterFrames("nila_peek_bottom", 6),
    loop: "none",
    holdLast: true,
    anchor: { x: "center", y: "bottom" },
  },
  "peek-bottom-exit": {
    name: "peek-bottom-exit",
    frames: exitFrames("nila_peek_bottom", 6),
    loop: "none",
    anchor: { x: "center", y: "bottom" },
  },
  "peek-top": {
    name: "peek-top",
    frames: enterFrames("nila_hang_top", 5),
    loop: "none",
    holdLast: true,
    anchor: { x: "center", y: "top" },
  },
  "peek-top-exit": {
    name: "peek-top-exit",
    frames: exitFrames("nila_hang_top", 5),
    loop: "none",
    anchor: { x: "center", y: "top" },
  },
  // Optional hanging mode (character setting "hang from top"): she hangs
  // upside-down from the top edge. Only the character is inverted — the
  // bubble stays upright (handled by the caller).
  "peek-top-hang": {
    name: "peek-top-hang",
    frames: enterFrames("nila_hang_upside", 6),
    loop: "none",
    holdLast: true,
    anchor: { x: "center", y: "top" },
  },
  "peek-top-hang-exit": {
    name: "peek-top-hang-exit",
    frames: exitFrames("nila_hang_upside", 6),
    loop: "none",
    anchor: { x: "center", y: "top" },
  },

  // -- Corner peeks (dedicated corner assets; never rotated).
  "peek-top-left": {
    name: "peek-top-left",
    frames: enterFrames("nila_corner_tl", 8),
    loop: "none",
    holdLast: true,
    anchor: { x: "left", y: "top" },
  },
  "peek-top-left-exit": {
    name: "peek-top-left-exit",
    frames: exitFrames("nila_corner_tl", 8),
    loop: "none",
    anchor: { x: "left", y: "top" },
  },
  "peek-top-right": {
    name: "peek-top-right",
    frames: enterFrames("nila_corner_tr", 6),
    loop: "none",
    holdLast: true,
    anchor: { x: "right", y: "top" },
  },
  "peek-top-right-exit": {
    name: "peek-top-right-exit",
    frames: exitFrames("nila_corner_tr", 6),
    loop: "none",
    anchor: { x: "right", y: "top" },
  },
  "peek-bottom-left": {
    name: "peek-bottom-left",
    frames: enterFrames("nila_corner_bl", 6),
    loop: "none",
    holdLast: true,
    anchor: { x: "left", y: "bottom" },
  },
  "peek-bottom-left-exit": {
    name: "peek-bottom-left-exit",
    frames: exitFrames("nila_corner_bl", 6),
    loop: "none",
    anchor: { x: "left", y: "bottom" },
  },
  "peek-bottom-right": {
    name: "peek-bottom-right",
    frames: enterFrames("nila_corner_br", 6),
    loop: "none",
    holdLast: true,
    anchor: { x: "right", y: "bottom" },
  },
  "peek-bottom-right-exit": {
    name: "peek-bottom-right-exit",
    frames: exitFrames("nila_corner_br", 6),
    loop: "none",
    anchor: { x: "right", y: "bottom" },
  },
};

/** Every asset key referenced by the manifest (for preloading). */
export type MotionSequenceName = string;
export function allManifestKeys(): string[] {
  const keys = new Set<string>();
  for (const seq of Object.values(MOTION_SEQUENCES)) {
    for (const f of seq.frames) keys.add(f.key);
  }
  return [...keys];
}

/** Keys for the sequences Nila needs before she first appears. */
export const CORE_SEQUENCE_NAMES = [
  "idle",
  "wave",
  "peek-top-left",
  "reminder-enter",
  "reminder-wait",
  "reminder-react",
  "reminder-retreat",
  "snooze-ack",
] as const;

export const BLINK_KEY = "nila_blink";

/**
 * Asset fallback hierarchy (spec section 26). Never throws; returns null
 * when nothing usable exists so the caller can fall back to the legacy
 * state image.
 *
 *   specific frame -> nearest numbered sibling -> sequence's first frame
 *   -> idle frame -> null
 */
export function resolveFrameKey(
  requested: string,
  available: ReadonlySet<string>,
): string | null {
  if (available.has(requested)) return requested;
  const numberedMatch = requested.match(/^(.*)_(\d+)$/);
  if (numberedMatch) {
    const stem = numberedMatch[1];
    const width = numberedMatch[2].length;
    const n = parseInt(numberedMatch[2], 10);
    for (let d = 1; d <= 12; d++) {
      const down = `${stem}_${String(n - d).padStart(width, "0")}`;
      if (n - d >= 1 && available.has(down)) return down;
      const up = `${stem}_${String(n + d).padStart(width, "0")}`;
      if (available.has(up)) return up;
    }
  }
  for (const seq of Object.values(MOTION_SEQUENCES)) {
    if (seq.frames.some((f) => f.key === requested)) {
      const first = seq.frames[0].key;
      if (available.has(first)) return first;
    }
  }
  if (available.has("nila_idle_01")) return "nila_idle_01";
  return null;
}

export type PeekDir =
  | "left"
  | "right"
  | "top"
  | "bottom"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

/**
 * Map a 9-position presence preset to its peek enter/exit sequences.
 * "center" has no peek frames (use a fade entrance instead). The top
 * preset uses the hanging set when hang mode is enabled.
 */
export function peekSequenceForPreset(
  preset: string,
  hangMode: boolean,
): { enter: string; exit: string } | null {
  switch (preset) {
    case "left":
      return { enter: "peek-left", exit: "peek-left-exit" };
    case "right":
      return { enter: "peek-right", exit: "peek-right-exit" };
    case "bottom":
      return { enter: "peek-bottom", exit: "peek-bottom-exit" };
    case "top":
      return hangMode
        ? { enter: "peek-top-hang", exit: "peek-top-hang-exit" }
        : { enter: "peek-top", exit: "peek-top-exit" };
    case "top-left":
      return { enter: "peek-top-left", exit: "peek-top-left-exit" };
    case "top-right":
      return { enter: "peek-top-right", exit: "peek-top-right-exit" };
    case "bottom-left":
      return { enter: "peek-bottom-left", exit: "peek-bottom-left-exit" };
    case "bottom-right":
      return { enter: "peek-bottom-right", exit: "peek-bottom-right-exit" };
    default:
      return null;
  }
}

/**
 * Irregular but bounded blink interval: 3.5-7s. Never a fixed cadence,
 * never rapid-fire (spec section 16).
 */
export function nextBlinkDelayMs(): number {
  return 3500 + Math.random() * 3500;
}
