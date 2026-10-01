/**
 * dockNilaAnim — maps a dock reaction slot to a one-shot CSS animation
 * class for Nila's figure. Pure and PNG-free so unit tests can import it.
 *
 * Keep the movement restrained: each reaction plays exactly once, uses
 * small amplitudes, and never loops.
 */

import type { ExpressionSlot } from "./expressionSlots";

export type DockNilaAnim = "cheer" | "droop" | "huff" | null;

/** Reaction slot -> one-shot animation. Null/neutral slots get none. */
export function dockNilaAnimForReaction(reaction: ExpressionSlot | null): DockNilaAnim {
  switch (reaction) {
    case "happy":
      return "cheer";
    case "sad":
      return "droop";
    case "annoyed":
      return "huff";
    default:
      return null;
  }
}

/** One-shot animation -> CSS class applied to the expression img. */
export function dockNilaAnimClass(anim: DockNilaAnim): string {
  switch (anim) {
    case "cheer":
      return "dock-nila-cheer";
    case "droop":
      return "dock-nila-droop";
    case "huff":
      return "dock-nila-huff";
    default:
      return "";
  }
}
