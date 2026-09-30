import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ACTIONS,
  BUILT_IN_MESSAGES,
  BUILT_IN_TITLES,
  ONBOARDING,
  SETTINGS_LABELS,
  pickVariant,
} from "../src/lib/strings.ts";

const MALAYALAM = /[\u0D00-\u0D7F]/;

describe("Malayalam strings", () => {
  it("every built-in kind has titles and multiple message variants", () => {
    for (const kind of ["water", "food", "break", "move", "sleep"]) {
      assert.match(BUILT_IN_TITLES[kind], MALAYALAM, `${kind} title`);
      const variants = BUILT_IN_MESSAGES[kind];
      assert.ok(variants.length >= 2, `${kind} needs >= 2 variants`);
      for (const v of variants) assert.match(v, MALAYALAM, `${kind} variant`);
    }
  });

  it("pickVariant rotates through variants", () => {
    const kinds = Object.keys(BUILT_IN_MESSAGES);
    const kind = kinds[0];
    const n = BUILT_IN_MESSAGES[kind].length;
    assert.equal(pickVariant(kind, 0), BUILT_IN_MESSAGES[kind][0]);
    assert.equal(pickVariant(kind, n), BUILT_IN_MESSAGES[kind][0]);
    assert.equal(pickVariant("nope", 0), "");
  });

  it("primary actions are Malayalam", () => {
    assert.equal(ACTIONS.later, "പിന്നീട്");
    assert.match(ACTIONS.ok, MALAYALAM);
    assert.match(ACTIONS.testReminder, MALAYALAM);
  });

  it("onboarding copy is Malayalam and introduces the character first", () => {
    assert.match(ONBOARDING.hello, MALAYALAM);
    assert.match(ONBOARDING.intro, /നില/);
  });

  it("settings labels cover all required sections", () => {
    for (const key of ["general", "reminders", "character", "appearance", "schedule", "about"]) {
      assert.match(SETTINGS_LABELS[key as keyof typeof SETTINGS_LABELS], MALAYALAM, key);
    }
  });
});
