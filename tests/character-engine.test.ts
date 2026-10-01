import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CharacterEngine } from "../src/character/engine.ts";

describe("CharacterEngine", () => {
  it("starts idle with breathing animation", () => {
    const e = new CharacterEngine();
    const s = e.snapshot();
    assert.equal(s.state, "idle");
    assert.equal(s.animation, "idle-breathe");
    assert.equal(s.visible, true);
    assert.equal(s.size, "small");
  });

  it("rejects illegal transitions so stuck states surface early", () => {
    const e = new CharacterEngine();
    e.setState("sleeping");
    assert.throws(() => e.setState("waving"), /Illegal character transition/);
  });

  it("runs the water reminder sequence: attention -> reminding -> happy wave", () => {
    const e = new CharacterEngine();
    e.beginReminder("water");
    assert.equal(e.snapshot().state, "reminding");
    assert.equal(e.isReminding(), true);
    e.dismissReminder();
    // She smiles and waves; the caller sequences the exit. The wave must
    // be the visible final animation (not batched away).
    assert.equal(e.snapshot().state, "happy");
    assert.equal(e.snapshot().animation, "wave");
    assert.equal(e.isReminding(), false);
  });

  it("custom reminders go straight to reminding with attention", () => {
    const e = new CharacterEngine();
    const seen: string[] = [];
    e.onChange((s) => seen.push(s.state));
    e.beginReminder("custom");
    // No invisible intermediate: the attention plays on reminding.
    assert.ok(!seen.includes("thinking"));
    assert.equal(e.snapshot().state, "reminding");
    assert.equal(e.snapshot().animation, "attention");
  });

  it("sleep reminders go straight to reminding", () => {
    const e = new CharacterEngine();
    const seen: string[] = [];
    e.onChange((s) => seen.push(s.state));
    e.beginReminder("sleep");
    assert.ok(!seen.includes("sleeping"));
    assert.equal(e.snapshot().state, "reminding");
  });

  it("snooze leaves her drowsy but visible; the caller hides the window", () => {
    const e = new CharacterEngine();
    e.beginReminder("water");
    e.snoozeReminder();
    assert.equal(e.snapshot().state, "sleeping");
    assert.equal(e.snapshot().visible, true);
    assert.equal(e.snapshot().animation, "snooze");
  });

  it("pause works from any state and resume returns", () => {
    const e = new CharacterEngine();
    e.setState("happy");
    e.pause();
    assert.equal(e.snapshot().state, "paused");
    e.resume();
    assert.equal(e.snapshot().state, "happy");
  });

  it("returnToIdle never leaves the character stuck while paused", () => {
    const e = new CharacterEngine();
    e.pause();
    e.returnToIdle();
    assert.equal(e.snapshot().state, "paused"); // pause persists until resume()
    e.resume();
    e.returnToIdle();
    assert.equal(e.snapshot().state, "idle");
  });

  it("interruptAnimation restores the state's default animation", () => {
    const e = new CharacterEngine();
    e.playAnimation("wave");
    assert.equal(e.snapshot().animation, "wave");
    e.interruptAnimation();
    assert.equal(e.snapshot().animation, "idle-breathe");
  });

  it("reduced motion disables continuous breathing and bounce", () => {
    const e = new CharacterEngine();
    e.setMotion("reduced");
    assert.equal(e.snapshot().animation, null);
    e.playAnimation("happy-bounce");
    assert.equal(e.snapshot().animation, null);
    e.playAnimation("wave"); // discrete reactions still allowed
    assert.equal(e.snapshot().animation, "wave");
  });

  it("motion off kills all animation", () => {
    const e = new CharacterEngine();
    e.setMotion("off");
    e.playAnimation("celebrate");
    assert.equal(e.snapshot().animation, null);
    e.beginReminder("water");
    assert.equal(e.snapshot().state, "reminding");
    assert.equal(e.snapshot().animation, null);
  });

  it("wave greeting then back to idle", () => {
    const e = new CharacterEngine();
    e.wave();
    assert.equal(e.snapshot().state, "waving");
    e.returnToIdle();
    assert.equal(e.snapshot().state, "idle");
  });

  it("notifies listeners on change", () => {
    const e = new CharacterEngine();
    let count = 0;
    const off = e.onChange(() => count++);
    e.setState("happy");
    e.setSize("large");
    assert.equal(count, 2);
    off();
    e.setState("idle");
    assert.equal(count, 2);
  });
});
