import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CharacterEngine } from "../src/character/engine.ts";

/** Advance exactly n frames (tests drive the engine manually, no timers). */
function step(e: CharacterEngine, n: number): void {
  for (let i = 0; i < n; i++) e.advanceFrame();
}

describe("engine frame sequences", () => {
  it("starts with the idle frame loop under full motion", () => {
    const e = new CharacterEngine();
    const s = e.snapshot();
    assert.equal(s.sequence, "idle");
    assert.equal(s.frame?.sequence, "idle");
    assert.equal(s.frame?.index, 0);
  });

  it("loops the idle frames and wraps around", () => {
    const e = new CharacterEngine();
    const first = e.snapshot().frame!.key;
    e.advanceFrame();
    const second = e.snapshot().frame!.key;
    assert.notEqual(first, second);
    e.advanceFrame();
    assert.equal(e.snapshot().frame!.key, first, "idle loop wraps");
  });

  it("plays a one-shot with per-frame timing and holds the landing", () => {
    const e = new CharacterEngine();
    const ended: string[] = [];
    e.onSequenceEnd((n) => ended.push(n));
    e.beginReminder("water");
    assert.equal(e.snapshot().state, "reminding");
    assert.equal(e.snapshot().sequence, "reminder-enter");
    // 4 frames: notice -> look -> enter -> settle(hold).
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      seen.push(e.snapshot().frame!.key);
      e.advanceFrame();
    }
    assert.deepEqual(ended, ["reminder-enter"], "end fires exactly once");
    assert.ok(
      seen[seen.length - 1].includes("settle"),
      `lands on settle, saw ${seen.join(",")}`,
    );
    assert.equal(
      e.snapshot().frame!.key,
      seen[seen.length - 1],
      "landing frame is held",
    );
  });

  it("chains sequences: enter -> wait loop", () => {
    const e = new CharacterEngine();
    const ended: string[] = [];
    e.onSequenceEnd((n) => ended.push(n));
    e.playChain(["reminder-enter", "reminder-wait"]);
    assert.equal(e.snapshot().sequence, "reminder-enter");
    // Advance past the enter beats -> moves to wait.
    for (let i = 0; i < 4; i++) e.advanceFrame();
    assert.equal(e.snapshot().sequence, "reminder-wait");
    assert.deepEqual(ended, ["reminder-enter"]);
    // The wait loop keeps cycling without ending.
    const k1 = e.snapshot().frame!.key;
    e.advanceFrame();
    e.advanceFrame();
    assert.equal(e.snapshot().sequence, "reminder-wait");
    assert.deepEqual(ended, ["reminder-enter"]);
    assert.notEqual(k1, undefined);
  });

  it("state changes retire the running sequence", () => {
    const e = new CharacterEngine();
    e.beginReminder("water");
    assert.ok(e.snapshot().frame);
    e.setState("idle");
    // Back to idle: the idle loop restarts, the reminder frames are gone.
    assert.equal(e.snapshot().sequence, "idle");
    e.stopSequence();
    assert.equal(e.snapshot().frame, null);
  });

  it("dismiss: completed earns thumbs-up, plain dismiss reacts", () => {
    const e = new CharacterEngine();
    const ended: string[] = [];
    e.onSequenceEnd((n) => ended.push(n));
    e.dismissReminder(true);
    assert.equal(e.snapshot().state, "happy");
    assert.equal(e.snapshot().sequence, "thumbsup");
    step(e, 5); // 6 frames -> landing
    assert.equal(e.snapshot().frame!.index, 5);
    step(e, 1); // lands: fires, chains the retreat
    assert.deepEqual(ended, ["thumbsup"]);
    assert.equal(e.snapshot().sequence, "reminder-retreat");
    step(e, 2); // retreat plays out and clears
    assert.deepEqual(ended, ["thumbsup", "reminder-retreat"]);
    assert.equal(e.snapshot().frame, null);
    step(e, 3); // parked: no double-fire, no resurrection
    assert.deepEqual(ended, ["thumbsup", "reminder-retreat"]);

    const e2 = new CharacterEngine();
    const ended2: string[] = [];
    e2.onSequenceEnd((n) => ended2.push(n));
    e2.dismissReminder(false);
    assert.equal(e2.snapshot().sequence, "reminder-react");
    step(e2, 1); // react: 2 frames, holdLast
    step(e2, 1);
    assert.deepEqual(ended2, ["reminder-react"]);
    step(e2, 2);
    assert.deepEqual(ended2, ["reminder-react", "reminder-retreat"]);
    assert.equal(e2.snapshot().frame, null);
  });

  it("snooze: understanding look, then retreat", () => {
    const e = new CharacterEngine();
    const ended: string[] = [];
    e.onSequenceEnd((n) => ended.push(n));
    e.snoozeReminder();
    assert.equal(e.snapshot().state, "sleeping");
    assert.equal(e.snapshot().sequence, "snooze-ack");
    step(e, 2); // 2 frames, holdLast -> fires on the 2nd
    assert.deepEqual(ended, ["snooze-ack"]);
    assert.equal(e.snapshot().sequence, "reminder-retreat");
    step(e, 2);
    assert.deepEqual(ended, ["snooze-ack", "reminder-retreat"]);
    assert.equal(e.snapshot().frame, null);
  });

  it("wave plays out and back", () => {
    const e = new CharacterEngine();
    const ended: string[] = [];
    e.onSequenceEnd((n) => ended.push(n));
    e.wave();
    assert.equal(e.snapshot().sequence, "wave");
    step(e, 11); // pingpong: 0..5..0, ends on the 11th
    assert.deepEqual(ended, ["wave"]);
    assert.equal(e.snapshot().frame, null, "wave clears after finishing");
    e.returnToIdle(); // the app does this on the wave end event
  });

  it("blink flash overrides and then resumes the sequence", () => {
    const e = new CharacterEngine();
    const idleKey = e.snapshot().frame!.key;
    e.flashFrame("nila_blink");
    assert.equal(e.snapshot().sequence, "flash");
    assert.equal(e.snapshot().frame!.key, "nila_blink");
    e.clearFlash();
    assert.equal(e.snapshot().sequence, "idle");
    assert.equal(e.snapshot().frame!.key, idleKey, "idle resumes");
  });

  it("reduced/off motion disables frame sequences entirely", () => {
    const e = new CharacterEngine();
    e.setMotion("reduced");
    assert.equal(e.snapshot().frame, null);
    e.playSequence("wave");
    assert.equal(e.snapshot().frame, null, "no frames under reduced motion");
    e.flashFrame("nila_blink");
    assert.equal(e.snapshot().frame, null);

    e.setMotion("off");
    e.beginReminder("water");
    assert.equal(e.snapshot().state, "reminding");
    assert.equal(e.snapshot().frame, null, "no frames when motion is off");

    e.setMotion("full");
    e.returnToIdle();
    assert.equal(e.snapshot().sequence, "idle", "full motion restores idle");
  });

  it("unknown sequence names never break the character", () => {
    const e = new CharacterEngine();
    e.playSequence("does-not-exist");
    assert.equal(e.snapshot().sequence, "idle", "still idling");
    e.playChain(["nope", "nah"]);
    assert.equal(e.snapshot().frame, null);
  });
});
