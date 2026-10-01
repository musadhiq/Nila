import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  NotificationPosition,
  dockWindowOrigin,
} from "../src/dock/positions.ts";

const monitor = { x: 0, y: 0, width: 1920, height: 1080 };

describe("dock positions", () => {
  it("exposes TOP_CENTER as the only implemented position", () => {
    assert.equal(NotificationPosition.TOP_CENTER, "top-center");
  });

  it("centers the dock horizontally with a safe top margin", () => {
    const o = dockWindowOrigin(NotificationPosition.TOP_CENTER, monitor, 520, 560, 12);
    assert.equal(o.x, Math.round((1920 - 520) / 2));
    assert.equal(o.y, 12);
  });

  it("respects a non-zero monitor origin (multi-monitor)", () => {
    const right = { x: 1920, y: 0, width: 1920, height: 1080 };
    const o = dockWindowOrigin(NotificationPosition.TOP_CENTER, right, 520, 560, 12);
    assert.equal(o.x, 1920 + Math.round((1920 - 520) / 2));
    assert.equal(o.y, 12);
  });

  it("clamps the window inside the monitor on very narrow displays", () => {
    const narrow = { x: 0, y: 0, width: 400, height: 800 };
    const o = dockWindowOrigin(NotificationPosition.TOP_CENTER, narrow, 520, 560, 12);
    assert.equal(o.x, 0);
    assert.ok(o.x + 520 >= narrow.width); // allowed to overflow only when the window is wider
  });

  it("falls back to top-center for unknown future positions", () => {
    const o = dockWindowOrigin("bottom-center" as never, monitor, 520, 560, 12);
    assert.equal(o.x, Math.round((1920 - 520) / 2));
    assert.equal(o.y, 12);
  });
});
