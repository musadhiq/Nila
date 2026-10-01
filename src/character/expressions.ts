// Expression manifest — the concept-sheet expression set, one PNG per
// expression in character/expressions/.
//
// Expressions are momentary faces flashed OVER the current engine state
// (see CharacterEngine.showExpression / clearExpression). They are not
// engine states: the 12 states in character/ stay the source of truth for
// sustained modes (idle, reminding, sleeping, ...).
//
// This module is PNG-free on purpose: imageForExpression-style maps live
// in NilaCharacter.tsx (bundled by Vite), so node --test can import this.

/**
 * The 12 concept-sheet expressions. File names mostly match the union
 * member; the exceptions are "thumbs-up" -> thumbs_up.png,
 * "rest-chin" -> rest_chin.png, and "idea" -> excited.png (the sheet has
 * no dedicated idea cell; excited is the eureka read).
 */
export type ExpressionName =
  | "surprised"
  | "sleepy"
  | "proud"
  | "curious"
  | "playful"
  | "confused"
  | "facepalm"
  | "idea"
  | "point"
  | "thumbs-up"
  | "explain"
  | "rest-chin";

export const EXPRESSION_ORDER: ExpressionName[] = [
  "surprised",
  "sleepy",
  "proud",
  "curious",
  "playful",
  "confused",
  "facepalm",
  "idea",
  "point",
  "thumbs-up",
  "explain",
  "rest-chin",
];

/** Screen-reader labels, in plain English like the rest of the UI. */
export const EXPRESSION_LABEL: Record<ExpressionName, string> = {
  surprised: "Surprised Nila",
  sleepy: "Sleepy Nila",
  proud: "Proud Nila",
  curious: "Curious Nila",
  playful: "Playful Nila",
  confused: "Confused Nila",
  facepalm: "Sheepish Nila",
  idea: "Nila with an idea",
  point: "Nila pointing",
  "thumbs-up": "Nila giving a thumbs up",
  explain: "Nila explaining",
  "rest-chin": "Nila resting her chin",
};

/**
 * Where each expression is used. Expressions without a moment are
 * reserved for future beats (documented here so they don't rot).
 *
 * NOTE: notification-context expressions (which face Nila shows for a
 * reminder kind, a success, or a rejection) are owned by the
 * centralized system in `dock/expressionSlots.ts` — not here. This
 * table only covers the engine's momentary overlay flashes.
 */
export const EXPRESSION_MOMENTS: Record<ExpressionName, string> = {
  surprised: "engine overlay — attention beat",
  point: "engine overlay — points at something",
  sleepy: "engine overlay — snoozed beat",
  proud: "engine overlay — encouragement moments",
  confused: "backup import failed",
  idea: "reserved — e.g. a reminder was just created",
  curious: "reserved — idle variety",
  playful: "reserved — idle variety / easter eggs",
  facepalm: "reserved — missed-reminder beat",
  "thumbs-up": "reserved — encouragement moments",
  explain: "reserved — onboarding / help beats",
  "rest-chin": "reserved — idle variety",
};
