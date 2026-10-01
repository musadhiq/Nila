/**
 * Semantic expression slots for the notification dock — pure mapping,
 * no asset imports (kept importable from node:test).
 *
 * Components never pick an image directly. They ask for a *meaning*
 * (a reminder kind, a greeting, a dismissal) and this module resolves
 * it to a slot; `expressions.ts` turns the slot into a bundled URL.
 * The face and body language must communicate the notification even
 * without reading the text.
 *
 * Negative reactions stay cute and brief — never guilt-tripping.
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
  | "playful" // warm fallback
  | "sad" // one dismissal: brief, cute, no guilt
  | "annoyed"; // repeated dismissals: mild huff, still cute

/**
 * Reminder kind -> the expression slot that reads without the text.
 * "stretch" / "exercise" / "work" are not reminder kinds yet; the
 * slots are mapped so the expressions light up as soon as they are.
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

/**
 * Negative-action reaction. `consecutiveDismissals` counts back-to-back
 * dismissals in this session (reset by done/snooze). One rejection gets
 * a brief sad beat; a streak of three or more gets a mild annoyed huff.
 */
export function expressionSlotForDismissal(
  consecutiveDismissals: number,
): ExpressionSlot {
  return consecutiveDismissals >= 3 ? "annoyed" : "sad";
}
