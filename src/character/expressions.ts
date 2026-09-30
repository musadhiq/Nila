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

/** The 12 concept-sheet expressions, each with character/expressions/<name>.png. */
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
 */
export const EXPRESSION_MOMENTS: Record<ExpressionName, string> = {
  surprised: "reminder fires — the attention beat before the overlay",
  point: "follows surprised — points at the reminder bubble",
  sleepy: "reminder snoozed",
  proud: "reminder marked done",
  confused: "backup import failed",
  idea: "reserved — e.g. a reminder was just created",
  curious: "reserved — idle variety",
  playful: "reserved — idle variety / easter eggs",
  facepalm: "reserved — missed-reminder beat",
  "thumbs-up": "reserved — encouragement moments",
  explain: "reserved — onboarding / help beats",
  "rest-chin": "reserved — idle variety",
};
