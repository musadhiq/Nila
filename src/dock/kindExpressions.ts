import type { ExpressionName } from "../character/expressions";

/**
 * Character expression shown in the notification dock for each reminder
 * kind. The built-in kinds each get their own fitting expression; anything
 * user-configured (or unknown) falls back to the generic pointing
 * attention expression.
 */
export const KIND_EXPRESSIONS: Record<string, ExpressionName> = {
  water: "idea", // bright idea: drink some water!
  food: "playful", // warm and inviting, like mealtime
  break: "rest-chin", // resting face for rest time
  move: "curious", // nudging you to get up and stretch
  sleep: "sleepy", // winding down
  greeting: "playful", // friendly hello from the tray
  custom: "point", // generic attention for user-configured events
};

/** Expression for a dock notification kind; "point" when unknown. */
export function expressionForKind(kind: string | undefined): ExpressionName {
  return KIND_EXPRESSIONS[kind ?? ""] ?? "point";
}
