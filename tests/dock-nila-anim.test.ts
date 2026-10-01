/**
 * dockNilaAnim — the reaction -> one-shot animation contract.
 *
 * Every reaction slot the dock can raise must map to a restrained,
 * single-play animation; neutral slots must map to none.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dockNilaAnimClass, dockNilaAnimForReaction } from "../src/dock/dockNilaAnim.ts";

describe("dockNilaAnimForReaction", () => {
  it("maps success (happy) to a cheer", () => {
    assert.equal(dockNilaAnimForReaction("happy"), "cheer");
  });

  it("maps rejection (sad) to a droop", () => {
    assert.equal(dockNilaAnimForReaction("sad"), "droop");
  });

  it("maps repeated rejection (annoyed) to a huff", () => {
    assert.equal(dockNilaAnimForReaction("annoyed"), "huff");
  });

  it("maps no reaction and neutral slots to no animation", () => {
    for (const slot of [null, "greeting", "hungry", "pointing", "sleepy"] as const) {
      assert.equal(dockNilaAnimForReaction(slot), null, `slot ${slot}`);
    }
  });
});

describe("dockNilaAnimClass", () => {
  it("resolves every animation to its CSS class", () => {
    assert.equal(dockNilaAnimClass("cheer"), "dock-nila-cheer");
    assert.equal(dockNilaAnimClass("droop"), "dock-nila-droop");
    assert.equal(dockNilaAnimClass("huff"), "dock-nila-huff");
  });

  it("resolves null to an empty class", () => {
    assert.equal(dockNilaAnimClass(null), "");
  });
});
