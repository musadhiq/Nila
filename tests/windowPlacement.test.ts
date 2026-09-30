import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  glidePosition,
  homePosition,
  isOnAnyMonitor,
  loadSavedPosition,
  saveWindowPosition,
  trayStartPosition,
} from "../src/lib/windowPlacement.ts";

// Minimal browser stubs for node.
const store = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
  setItem: (k: string, v: string) => {
    store.set(k, v);
  },
  removeItem: (k: string) => {
    store.delete(k);
  },
};
(globalThis as Record<string, unknown>).requestAnimationFrame = (
  cb: (t: number) => void,
) => {
  setTimeout(() => cb(performance.now()), 0);
  return 0;
};

describe("windowPlacement", () => {
  beforeEach(() => store.clear());

  it("persists and loads the home position", () => {
    assert.equal(loadSavedPosition(), null);
    saveWindowPosition(120, 340);
    assert.deepEqual(loadSavedPosition(), { x: 120, y: 340 });
  });

  it("rejects corrupted storage", () => {
    store.set("nila.windowPos.v1", "nope{");
    assert.equal(loadSavedPosition(), null);
  });

  it("homes to bottom-right with a margin", () => {
    const mon = { x: 0, y: 0, width: 1920, height: 1080 };
    assert.deepEqual(homePosition(mon, 220, 300), { x: 1684, y: 764 });
  });

  it("starts the fly-in under the top bar at top-right", () => {
    const mon = { x: 0, y: 0, width: 1920, height: 1080 };
    assert.deepEqual(trayStartPosition(mon, 220), { x: 1688, y: 36 });
  });

  it("detects on/off-monitor positions", () => {
    const mons = [{ x: 0, y: 0, width: 1920, height: 1080 }];
    assert.equal(isOnAnyMonitor({ x: 100, y: 100 }, mons), true);
    assert.equal(isOnAnyMonitor({ x: 5000, y: 100 }, mons), false);
    // Second monitor counts too.
    const two = [...mons, { x: 1920, y: 0, width: 1920, height: 1080 }];
    assert.equal(isOnAnyMonitor({ x: 2000, y: 100 }, two), true);
  });

  it("glides from the tray to home and lands exactly", async () => {
    const seen: Array<[number, number]> = [];
    await glidePosition({ x: 1688, y: 36 }, { x: 1684, y: 764 }, 30, (x, y) => {
      seen.push([x, y]);
    });
    assert.ok(seen.length > 1, "expected multiple frames");
    assert.deepEqual(seen[seen.length - 1], [1684, 764]);
    for (let i = 1; i < seen.length; i++) {
      assert.ok(seen[i][1] >= seen[i - 1][1], "y should ease monotonically here");
    }
  });
});
