import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { expressionForKind, KIND_EXPRESSIONS } from "../src/dock/kindExpressions.ts";

describe("kindExpressions", () => {
  it("maps every built-in reminder kind to an expression", () => {
    for (const kind of ["water", "food", "break", "move", "sleep"]) {
      assert.ok(KIND_EXPRESSIONS[kind], `missing expression for ${kind}`);
      assert.equal(expressionForKind(kind), KIND_EXPRESSIONS[kind]);
    }
  });

  it("gives greetings a friendly face", () => {
    assert.equal(expressionForKind("greeting"), "playful");
  });

  it("falls back to point for custom and unknown kinds", () => {
    assert.equal(expressionForKind("custom"), "point");
    assert.equal(expressionForKind("something-new"), "point");
    assert.equal(expressionForKind(undefined), "point");
  });
});
