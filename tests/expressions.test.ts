import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EXPRESSION_LABEL,
  EXPRESSION_MOMENTS,
  EXPRESSION_ORDER,
  type ExpressionName,
} from "../src/character/expressions.ts";
import { CharacterEngine } from "../src/character/engine.ts";

const EXPECTED: ExpressionName[] = [
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

describe("expressions", () => {
  it("covers the full concept-sheet expression set", () => {
    assert.deepEqual([...EXPRESSION_ORDER].sort(), [...EXPECTED].sort());
  });

  it("every expression has a label and a documented moment", () => {
    for (const name of EXPRESSION_ORDER) {
      assert.ok(EXPRESSION_LABEL[name], `missing label: ${name}`);
      assert.ok(EXPRESSION_MOMENTS[name], `missing moment doc: ${name}`);
    }
  });

  it("engine starts with no expression", () => {
    assert.equal(new CharacterEngine().snapshot().expression, null);
  });

  it("flashes and clears expressions without touching state", () => {
    const e = new CharacterEngine();
    const seen: Array<ExpressionName | null> = [];
    e.onChange((s) => seen.push(s.expression));
    e.showExpression("surprised");
    assert.equal(e.snapshot().expression, "surprised");
    assert.equal(e.snapshot().state, "idle");
    e.showExpression("point");
    e.clearExpression();
    assert.equal(e.snapshot().expression, null);
    assert.deepEqual(seen, ["surprised", "point", null]);
    e.clearExpression(); // no-op: no extra emission
    assert.deepEqual(seen, ["surprised", "point", null]);
  });
});
