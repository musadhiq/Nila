import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  expressionSlotForDismissal,
  expressionSlotForGreeting,
  expressionSlotForKind,
  type ExpressionSlot,
} from "../src/dock/expressionSlots.ts";

describe("expressionSlots", () => {
  it("maps every reminder kind to its contextual expression", () => {
    const cases: Array<[string, ExpressionSlot]> = [
      ["food", "hungry"],
      ["water", "thirsty"],
      ["stretch", "stretching"],
      ["sleep", "sleepy"],
      ["exercise", "energetic"],
      ["break", "relaxed"],
      ["work", "focused"],
      ["move", "stretching"],
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

  it("reacts sad to a single dismissal, annoyed after a streak", () => {
    assert.equal(expressionSlotForDismissal(1), "sad");
    assert.equal(expressionSlotForDismissal(2), "sad");
    assert.equal(expressionSlotForDismissal(3), "annoyed");
    assert.equal(expressionSlotForDismissal(10), "annoyed");
  });
});
