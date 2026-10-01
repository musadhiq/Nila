/**
 * Nila's centralized contextual expression system.
 *
 * This is the single source of truth for *which face Nila shows and
 * when*. Components never pick an image directly — they describe the
 * *context* (a reminder kind, a greeting, a success, a snooze, a rejection) and
 * this module resolves it to an expression slot. `expressions.ts` then
 * turns the slot into a bundled PNG URL.
 *
 * The face and body language must communicate the notification even
 * without reading the text. Negative reactions stay cute and brief —
 * never guilt-tripping.
 *
 * Kept PNG-free on purpose so node --test can import it directly.
 */

/**
 * What Nila should communicate — not which file to show.
 */
export type ExpressionSlot =
  | "greeting" // warm hello for the introduction card
  | "hungry" // food: tired, "I need food", hand on tummy
  | "thirsty" // water: weary, hand near mouth as if to drink
  | "stretching" // stretch/move: arms raised overhead, relaxed face
  | "sleepy" // sleep: heavy eyes, resting
  | "energetic" // exercise: bright smile, fist pumped
  | "relaxed" // break: calm, hand under chin
  | "focused" // work/study: intent, thinking
  | "pointing" // custom/unknown: gets your attention
  | "happy" // success: the reminder was completed
  | "sad" // one rejection: brief, cute, no guilt
  | "annoyed" // repeated rejections: mild huff, still cute
  | "acknowledge"; // snooze: understanding thumbs-up, "got it, later"

/**
 * Every moment Nila can react to. Exactly one resolver —
 * {@link expressionSlotForContext} — turns a context into a slot, so
 * the mapping can't drift between call sites.
 */
export type ExpressionContext =
  | { type: "kind"; kind: string }
  | { type: "greeting" }
  | { type: "success" }
  | { type: "snoozed" }
  | { type: "rejected"; consecutiveRejections: number };

/**
 * Reminder kind -> the expression slot that reads without the text.
 */
export function expressionSlotForKind(kind: string): ExpressionSlot {
  switch (kind) {
    case "food":
      return "hungry";
    case "water":
      return "thirsty";
    case "stretch":
      return "stretching";
    case "sleep":
      return "sleepy";
    case "exercise":
      return "energetic";
    case "break":
      return "relaxed";
    case "work":
      return "focused";
    case "move":
      return "stretching";
    default:
      return "pointing";
  }
}

export function expressionSlotForGreeting(): ExpressionSlot {
  return "greeting";
}

/** The reminder was completed — Nila is happy about it. */
export function expressionSlotForSuccess(): ExpressionSlot {
  return "happy";
}

/** The reminder was snoozed — Nila acknowledges, "got it, I'll remind you later". */
export function expressionSlotForSnooze(): ExpressionSlot {
  return "acknowledge";
}

/**
 * Negative-action reaction. `consecutiveRejections` counts back-to-back
 * dismissals in this session (reset by done/snooze). One rejection gets
 * a brief sad beat; a streak of three or more gets a mild annoyed huff.
 */
export function expressionSlotForDismissal(
  consecutiveRejections: number,
): ExpressionSlot {
  return consecutiveRejections >= 3 ? "annoyed" : "sad";
}

/**
 * The single entry point: resolve any expression context to its slot.
 * Prefer this over the granular helpers at new call sites.
 */
export function expressionSlotForContext(
  ctx: ExpressionContext,
): ExpressionSlot {
  switch (ctx.type) {
    case "kind":
      return expressionSlotForKind(ctx.kind);
    case "greeting":
      return expressionSlotForGreeting();
    case "success":
      return expressionSlotForSuccess();
    case "snoozed":
      return expressionSlotForSnooze();
    case "rejected":
      return expressionSlotForDismissal(ctx.consecutiveRejections);
  }
}

/**
 * Slot -> committed PNG filename under `character/expressions/`.
 * The single binding table: `expressions.ts` must bind every entry
 * here, and `tests/expression-assets.test.ts` asserts every file
 * exists on disk so a slot can never point at a missing asset.
 */
export const SLOT_FILENAMES: Record<ExpressionSlot, string> = {
  greeting: "curious.png",
  hungry: "hungry.png",
  thirsty: "thirsty.png",
  stretching: "stretching.png",
  sleepy: "sleepy.png",
  energetic: "energetic.png",
  relaxed: "rest_chin.png",
  focused: "focused.png",
  pointing: "point.png",
  happy: "happy.png",
  sad: "sad.png",
  annoyed: "annoyed.png",
  acknowledge: "thumbs_up.png",
};

/**
 * Slot -> blink frame PNG filenames under `character/expressions/`.
 * Every slot has a half-blink and a fully-closed frame, generated from
 * its own expression PNG (eyelids only — same pose, framing, and
 * transparent canvas). `blinkFrames.ts` binds these to bundled URLs;
 * `tests/expression-assets.test.ts` asserts every file exists on disk.
 */
export interface BlinkFilenames {
  half: string;
  closed: string;
}

export const SLOT_BLINK_FILENAMES: Record<ExpressionSlot, BlinkFilenames> = {
  greeting: {
    half: "blink/curious_blink_half.png",
    closed: "blink/curious_blink_closed.png",
  },
  hungry: {
    half: "blink/hungry_blink_half.png",
    closed: "blink/hungry_blink_closed.png",
  },
  thirsty: {
    half: "blink/thirsty_blink_half.png",
    closed: "blink/thirsty_blink_closed.png",
  },
  stretching: {
    half: "blink/stretching_blink_half.png",
    closed: "blink/stretching_blink_closed.png",
  },
  sleepy: {
    half: "blink/sleepy_blink_half.png",
    closed: "blink/sleepy_blink_closed.png",
  },
  energetic: {
    half: "blink/energetic_blink_half.png",
    closed: "blink/energetic_blink_closed.png",
  },
  relaxed: {
    half: "blink/rest_chin_blink_half.png",
    closed: "blink/rest_chin_blink_closed.png",
  },
  focused: {
    half: "blink/focused_blink_half.png",
    closed: "blink/focused_blink_closed.png",
  },
  pointing: {
    half: "blink/point_blink_half.png",
    closed: "blink/point_blink_closed.png",
  },
  happy: {
    half: "blink/happy_blink_half.png",
    closed: "blink/happy_blink_closed.png",
  },
  sad: { half: "blink/sad_blink_half.png", closed: "blink/sad_blink_closed.png" },
  annoyed: {
    half: "blink/annoyed_blink_half.png",
    closed: "blink/annoyed_blink_closed.png",
  },
  acknowledge: {
    half: "blink/thumbs_up_blink_half.png",
    closed: "blink/thumbs_up_blink_closed.png",
  },
};
