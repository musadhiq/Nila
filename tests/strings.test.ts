import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ACTIONS,
  BUILT_IN_MESSAGES,
  BUILT_IN_TITLES,
  ONBOARDING,
  pickVariant,
} from "../src/lib/strings.ts";

const MALAYALAM_SCRIPT = /[\u0D00-\u0D7F]/;

describe("Nila strings", () => {
  it("every built-in kind has titles and multiple message variants", () => {
    for (const kind of ["water", "food", "break", "move", "sleep"]) {
      assert.ok(BUILT_IN_TITLES[kind].length > 0, `${kind} title`);
      const variants = BUILT_IN_MESSAGES[kind];
      assert.ok(variants.length >= 2, `${kind} needs >= 2 variants`);
      for (const v of variants) assert.ok(v.length > 0, `${kind} variant`);
    }
  });

  it("Nila's voice is Manglish (no Malayalam script in reminders)", () => {
    for (const kind of Object.keys(BUILT_IN_MESSAGES)) {
      assert.doesNotMatch(BUILT_IN_TITLES[kind], MALAYALAM_SCRIPT, `${kind} title`);
      for (const v of BUILT_IN_MESSAGES[kind]) {
        assert.doesNotMatch(v, MALAYALAM_SCRIPT, `${kind} variant`);
      }
    }
    assert.doesNotMatch(ONBOARDING.intro, MALAYALAM_SCRIPT);
  });

  it("pickVariant rotates through variants", () => {
    const kinds = Object.keys(BUILT_IN_MESSAGES);
    const kind = kinds[0];
    const n = BUILT_IN_MESSAGES[kind].length;
    assert.equal(pickVariant(kind, 0), BUILT_IN_MESSAGES[kind][0]);
    assert.equal(pickVariant(kind, n), BUILT_IN_MESSAGES[kind][0]);
    assert.equal(pickVariant("nope", 0), "");
  });

  it("overlay actions are Manglish", () => {
    assert.equal(ACTIONS.later, "Pinneed");
    assert.equal(ACTIONS.ok, "Sheri");
    assert.equal(ACTIONS.snooze10, "10 minute kazhinj");
    assert.doesNotMatch(ACTIONS.later, MALAYALAM_SCRIPT);
  });

  it("onboarding greets first and introduces Nila", () => {
    assert.match(ONBOARDING.hello, /Hi/);
    assert.match(ONBOARDING.intro, /Nila/);
  });
});
