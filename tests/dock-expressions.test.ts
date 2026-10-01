import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  expressionSlotForContext,
  expressionSlotForDismissal,
  expressionSlotForGreeting,
  expressionSlotForKind,
  expressionSlotForSnooze,
  expressionSlotForSuccess,
  type ExpressionContext,
  type ExpressionSlot,
} from "../src/dock/expressionSlots.ts";

describe("expressionSlots", () => {
  it("maps every reminder type to its contextual expression", () => {
    const cases: Array<[string, ExpressionSlot]> = [
      ["food", "hungry"],
      ["water", "thirsty"],
      ["stretch", "stretching"],
      ["sleep", "sleepy"],
      ["exercise", "energetic"],
      ["break", "relaxed"],
      ["work", "focused"],
      ["move", "stretching"],
      ["battery", "sleepy"],
      ["cpu", "energetic"],
      ["memory", "focused"],
      ["disk", "pointing"],
    ];
    for (const [kind, slot] of cases) {
      assert.equal(expressionSlotForKind(kind), slot, `kind ${kind}`);
    }
  });

  it("falls back to the pointing expression for custom/unknown kinds", () => {
    assert.equal(expressionSlotForKind("custom"), "pointing");
    assert.equal(expressionSlotForKind("medication"), "pointing");
    assert.equal(expressionSlotForKind(""), "pointing");
  });

  it("greets with the greeting slot", () => {
    assert.equal(expressionSlotForGreeting(), "greeting");
  });

  it("shows happy on success", () => {
    assert.equal(expressionSlotForSuccess(), "happy");
  });

  it("acknowledges a snooze with an understanding thumbs-up", () => {
    assert.equal(expressionSlotForSnooze(), "acknowledge");
  });

  it("reacts sad to a single rejection, annoyed after a streak", () => {
    assert.equal(expressionSlotForDismissal(1), "sad");
    assert.equal(expressionSlotForDismissal(2), "sad");
    assert.equal(expressionSlotForDismissal(3), "annoyed");
    assert.equal(expressionSlotForDismissal(10), "annoyed");
  });

  it("resolves every context through the single entry point", () => {
    const cases: Array<[ExpressionContext, ExpressionSlot]> = [
      [{ type: "kind", kind: "food" }, "hungry"],
      [{ type: "kind", kind: "water" }, "thirsty"],
      [{ type: "kind", kind: "stretch" }, "stretching"],
      [{ type: "kind", kind: "sleep" }, "sleepy"],
      [{ type: "kind", kind: "exercise" }, "energetic"],
      [{ type: "kind", kind: "break" }, "relaxed"],
      [{ type: "kind", kind: "work" }, "focused"],
      [{ type: "kind", kind: "move" }, "stretching"],
      [{ type: "kind", kind: "custom" }, "pointing"],
      [{ type: "greeting" }, "greeting"],
      [{ type: "success" }, "happy"],
      [{ type: "snoozed" }, "acknowledge"],
      [{ type: "rejected", consecutiveRejections: 1 }, "sad"],
      [{ type: "rejected", consecutiveRejections: 2 }, "sad"],
      [{ type: "rejected", consecutiveRejections: 3 }, "annoyed"],
      [{ type: "rejected", consecutiveRejections: 7 }, "annoyed"],
    ];
    for (const [ctx, slot] of cases) {
      assert.equal(
        expressionSlotForContext(ctx),
        slot,
        `context ${JSON.stringify(ctx)}`,
      );
    }
  });
});
