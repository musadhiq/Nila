import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  dockReducer,
  initialDockState,
  isDockActionable,
  isDockOnScreen,
  type DockNotification,
} from "../src/dock/dockMachine.ts";

const n1: DockNotification = { id: "1", title: "T1", message: "M1", kind: "water" };
const n2: DockNotification = { id: "2", title: "T2", message: "M2", kind: "break" };
const n3: DockNotification = { id: "3", title: "T3", message: "M3", kind: "custom" };

function fullCycle(action: "completed" | "dismissed" | "snoozed" = "completed") {
  let s = initialDockState();
  s = dockReducer(s, { type: "notify", notification: n1 });
  s = dockReducer(s, { type: "enter-done" });
  s = dockReducer(s, { type: "expand-done" });
  s = dockReducer(s, { type: "dismiss", action });
  s = dockReducer(s, { type: "ack-done" });
  s = dockReducer(s, { type: "collapse-done" });
  return s;
}

describe("dockMachine", () => {
  it("starts hidden with an empty queue", () => {
    const s = initialDockState();
    assert.equal(s.phase, "hidden");
    assert.equal(s.current, null);
    assert.deepEqual(s.queue, []);
  });

  it("notify while hidden starts the enter sequence", () => {
    const s = dockReducer(initialDockState(), { type: "notify", notification: n1 });
    assert.equal(s.phase, "entering");
    assert.equal(s.current, n1);
  });

  it("walks the full lifecycle: entering -> expanding -> visible -> acknowledging -> collapsing -> hidden", () => {
    let s = initialDockState();
    s = dockReducer(s, { type: "notify", notification: n1 });
    assert.equal(s.phase, "entering");
    s = dockReducer(s, { type: "enter-done" });
    assert.equal(s.phase, "expanding");
    s = dockReducer(s, { type: "expand-done" });
    assert.equal(s.phase, "visible");
    s = dockReducer(s, { type: "interact" });
    assert.equal(s.phase, "interacting");
    s = dockReducer(s, { type: "disengage" });
    assert.equal(s.phase, "visible");
    s = dockReducer(s, { type: "dismiss", action: "completed" });
    assert.equal(s.phase, "acknowledging");
    assert.equal(s.ackAction, "completed");
    s = dockReducer(s, { type: "ack-done" });
    assert.equal(s.phase, "collapsing");
    s = dockReducer(s, { type: "collapse-done" });
    assert.equal(s.phase, "hidden");
    assert.equal(s.current, null);
  });

  it("a notify arriving mid-animation is queued, never restarts the current one", () => {
    let s = dockReducer(initialDockState(), { type: "notify", notification: n1 });
    s = dockReducer(s, { type: "enter-done" });
    s = dockReducer(s, { type: "notify", notification: n2 });
    assert.equal(s.phase, "expanding");
    assert.equal(s.current, n1);
    assert.deepEqual(s.queue, [n2]);
  });

  it("dismiss during entering still acknowledges (no stuck overlay)", () => {
    let s = dockReducer(initialDockState(), { type: "notify", notification: n1 });
    s = dockReducer(s, { type: "dismiss", action: "dismissed" });
    assert.equal(s.phase, "acknowledging");
    assert.equal(s.ackAction, "dismissed");
  });

  it("the next queued notification enters after the current one collapses", () => {
    let s = dockReducer(initialDockState(), { type: "notify", notification: n1 });
    s = dockReducer(s, { type: "notify", notification: n2 });
    s = dockReducer(s, { type: "notify", notification: n3 });
    s = dockReducer(s, { type: "enter-done" });
    s = dockReducer(s, { type: "expand-done" });
    s = dockReducer(s, { type: "dismiss", action: "snoozed" });
    s = dockReducer(s, { type: "ack-done" });
    s = dockReducer(s, { type: "collapse-done" });
    assert.equal(s.phase, "entering");
    assert.equal(s.current, n2);
    assert.deepEqual(s.queue, [n3]);
  });

  it("re-notifying the on-screen id refreshes instead of duplicating", () => {
    const updated = { ...n1, message: "new" };
    let s = dockReducer(initialDockState(), { type: "notify", notification: n1 });
    s = dockReducer(s, { type: "notify", notification: updated });
    assert.equal(s.current?.message, "new");
    assert.deepEqual(s.queue, []);
  });

  it("re-notifying a queued id replaces it in place", () => {
    let s = dockReducer(initialDockState(), { type: "notify", notification: n1 });
    s = dockReducer(s, { type: "notify", notification: n2 });
    s = dockReducer(s, { type: "notify", notification: { ...n2, message: "new" } });
    assert.equal(s.queue.length, 1);
    assert.equal(s.queue[0].message, "new");
  });

  it("ignores out-of-phase events so races are no-ops", () => {
    const s0 = initialDockState();
    assert.equal(dockReducer(s0, { type: "enter-done" }), s0);
    assert.equal(dockReducer(s0, { type: "dismiss", action: "completed" }), s0);
    assert.equal(dockReducer(s0, { type: "collapse-done" }), s0);
    let s = dockReducer(s0, { type: "notify", notification: n1 });
    assert.equal(dockReducer(s, { type: "collapse-done" }), s);
  });

  it("force-hide clears everything immediately", () => {
    let s = dockReducer(initialDockState(), { type: "notify", notification: n1 });
    s = dockReducer(s, { type: "notify", notification: n2 });
    s = dockReducer(s, { type: "force-hide" });
    assert.deepEqual(s, initialDockState());
  });

  it("isDockOnScreen is false only when hidden", () => {
    assert.equal(isDockOnScreen("hidden"), false);
    for (const p of ["entering", "expanding", "visible", "interacting", "acknowledging", "collapsing"] as const) {
      assert.equal(isDockOnScreen(p), true);
    }
  });

  it("isDockActionable matches the phases that honor dismiss", () => {
    // dismiss is honored from entering/expanding/visible/interacting and
    // ignored while acknowledging/collapsing/hidden — the guard must
    // agree exactly, so a second rapid action never reaches the backend.
    for (const p of ["entering", "expanding", "visible", "interacting"] as const) {
      assert.equal(isDockActionable(p), true);
      const s = dockReducer({ ...initialDockState(), phase: p }, { type: "dismiss", action: "completed" });
      assert.equal(s.phase, "acknowledging");
    }
    for (const p of ["acknowledging", "collapsing", "hidden"] as const) {
      assert.equal(isDockActionable(p), false);
      const s = dockReducer({ ...initialDockState(), phase: p }, { type: "dismiss", action: "completed" });
      assert.equal(s.phase, p);
    }
  });

  it("completes a full cycle for every ack action", () => {
    for (const a of ["completed", "dismissed", "snoozed"] as const) {
      const s = fullCycle(a);
      assert.equal(s.phase, "hidden");
      assert.equal(s.ackAction, null);
    }
  });
});
