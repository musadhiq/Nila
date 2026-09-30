import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  bubbleSideFor,
  characterTransformCSS,
  effectiveEntrance,
  effectiveExit,
  ensureVisible,
  nearestPreset,
  nextNaturalPosition,
  orientationFor,
  presetEdges,
  reminderWindowRect,
  slideStartFor,
  snapToEdge,
  stagePositionFor,
  tiltApplies,
  visibleFracForIdle,
  windowRectForPreset,
} from "../src/character/presence.ts";
import type { MonitorRect as WinMonitorRect } from "../src/lib/windowPlacement.ts";
import type { PositionPreset } from "../src/lib/types.ts";

const MON: WinMonitorRect = { x: 0, y: 0, width: 1920, height: 1080 };
const W = 220;
const H = 300;
const EDGE = 12;

describe("presence presets", () => {
  it("places bottom-right at the corner with the edge offset", () => {
    const r = windowRectForPreset({
      preset: "bottom-right", monitor: MON, winW: W, winH: H,
      edgeOffset: EDGE, visibleFrac: 1,
    });
    assert.equal(r.x, 1920 - W - EDGE);
    assert.equal(r.y, 1080 - H - EDGE);
  });

  it("places top-left at the corner with the edge offset", () => {
    const r = windowRectForPreset({
      preset: "top-left", monitor: MON, winW: W, winH: H,
      edgeOffset: EDGE, visibleFrac: 1,
    });
    assert.equal(r.x, EDGE);
    assert.equal(r.y, EDGE);
  });

  it("centers the window for the center preset", () => {
    const r = windowRectForPreset({
      preset: "center", monitor: MON, winW: W, winH: H,
      edgeOffset: EDGE, visibleFrac: 1,
    });
    assert.equal(r.x, Math.round((1920 - W) / 2));
    assert.equal(r.y, Math.round((1080 - H) / 2));
  });

  it("lets edge presets hang partly offscreen for peek amounts", () => {
    const r = windowRectForPreset({
      preset: "right", monitor: MON, winW: W, winH: H,
      edgeOffset: EDGE, visibleFrac: 0.25,
    });
    const visibleW = MON.x + MON.width - r.x;
    assert.ok(visibleW >= Math.round(W * 0.25) - 2, `visible ${visibleW}px`);
    assert.ok(r.x > MON.x + MON.width - W, "hangs past the edge");
  });

  it("clamps the fraction to [0, 1]", () => {
    const r = windowRectForPreset({
      preset: "left", monitor: MON, winW: W, winH: H,
      edgeOffset: EDGE, visibleFrac: 5,
    });
    assert.equal(r.x, EDGE);
  });
});

describe("preset edges", () => {
  it("maps each preset to its edge(s); corners report both", () => {
    assert.deepEqual(presetEdges("top-left"), ["top", "left"]);
    assert.deepEqual(presetEdges("right"), ["right"]);
    assert.deepEqual(presetEdges("center"), []);
    assert.deepEqual(presetEdges("bottom"), ["bottom"]);
    assert.deepEqual(presetEdges("bottom-right"), ["bottom", "right"]);
  });
});

describe("orientation", () => {
  it("mirrors the character to face the desktop", () => {
    // The art is front-facing: safe mirror transforms only (spec 48).
    assert.deepEqual(orientationFor("right", false), { scaleX: -1, scaleY: 1 });
    assert.deepEqual(orientationFor("left", false), { scaleX: 1, scaleY: 1 });
    assert.deepEqual(orientationFor("top", false), { scaleX: 1, scaleY: 1 });
    assert.deepEqual(orientationFor("center", false), { scaleX: 1, scaleY: 1 });
  });

  it("vertically inverts only when hanging from the top (opt-in)", () => {
    assert.deepEqual(orientationFor("top", true), { scaleX: 1, scaleY: -1 });
    // Not the default: no inversion without the explicit top-hang option.
    assert.deepEqual(orientationFor("top", false), { scaleX: 1, scaleY: 1 });
  });

  it("applies tilt only at side edges (spec 36)", () => {
    assert.equal(tiltApplies("left"), true);
    assert.equal(tiltApplies("right"), true);
    assert.equal(tiltApplies("top"), false);
    assert.equal(tiltApplies("bottom"), false);
    assert.equal(tiltApplies("center"), false);
  });

  it("builds a character-only transform with tilt clamped to ±8°", () => {
    const hang = characterTransformCSS("top", true, 0);
    assert.ok(hang.includes("scaleY(-1)"), hang);
    assert.ok(!hang.includes("scaleX"), hang);
    const tilted = characterTransformCSS("right", false, 5);
    assert.ok(tilted.includes("scaleX(-1)"), tilted);
    assert.ok(tilted.includes("rotate(5deg)"), tilted);
    const clamped = characterTransformCSS("right", false, 30);
    assert.ok(clamped.includes("rotate(8deg)"), clamped);
    const noTiltAtTop = characterTransformCSS("top", false, 5);
    assert.ok(!noTiltAtTop.includes("rotate"), noTiltAtTop);
  });
});

describe("bubble placement", () => {
  it("opens toward the desktop", () => {
    assert.equal(bubbleSideFor("right"), "left");
    assert.equal(bubbleSideFor("left"), "right");
    assert.equal(bubbleSideFor("top"), "below");
    assert.equal(bubbleSideFor("bottom"), "above");
    assert.equal(bubbleSideFor("center"), "above");
  });

  it("keeps the reminder window onscreen for every preset", () => {
    const presets = [
      "center", "top", "bottom", "left", "right",
      "top-left", "top-right", "bottom-left", "bottom-right",
    ] as const;
    for (const preset of presets) {
      const l = reminderWindowRect({
        preset, monitor: MON, charW: W, charH: H,
        bubbleW: 300, bubbleH: 280, edgeOffset: EDGE,
      });
      assert.ok(l.x >= MON.x, `${preset}: x ${l.x}`);
      assert.ok(l.y >= MON.y, `${preset}: y ${l.y}`);
      assert.ok(l.x + l.w <= MON.x + MON.width, `${preset}: right`);
      assert.ok(l.y + l.h <= MON.y + MON.height, `${preset}: bottom`);
    }
  });

  it("moves the bubble inside when it would overflow", () => {
    // Tiny monitor forces the bubble to flip inward.
    const tiny: WinMonitorRect = { x: 0, y: 0, width: 500, height: 400 };
    const l = reminderWindowRect({
      preset: "right", monitor: tiny, charW: W, charH: H,
      bubbleW: 300, bubbleH: 280, edgeOffset: EDGE,
    });
    assert.ok(l.x + l.w <= tiny.width, `right ${l.x + l.w}`);
  });
});

describe("slide starts", () => {
  it("starts fully offscreen in the edge direction", () => {
    const s = slideStartFor({
      preset: "right", monitor: MON, winW: W, winH: H, edgeOffset: EDGE,
    });
    assert.ok(s.x >= MON.width, `x ${s.x}`);
    const top = slideStartFor({
      preset: "top", monitor: MON, winW: W, winH: H, edgeOffset: EDGE,
    });
    assert.ok(top.y + H <= 0, `y ${top.y}`);
  });
});

describe("visibility recovery", () => {
  it("clamps a window dragged completely offscreen", () => {
    const f = ensureVisible(5000, 5000, W, H, [MON]);
    assert.ok(f.x + W <= MON.width);
    assert.ok(f.y + H <= MON.height);
  });

  it("leaves a peekable window alone", () => {
    const r = windowRectForPreset({
      preset: "right", monitor: MON, winW: W, winH: H,
      edgeOffset: EDGE, visibleFrac: 0.3,
    });
    const f = ensureVisible(r.x, r.y, W, H, [MON]);
    assert.equal(f.x, r.x);
    assert.equal(f.y, r.y);
  });

  it("recovers from a disconnected monitor", () => {
    const off: WinMonitorRect = { x: 4000, y: 0, width: 1920, height: 1080 };
    const f = ensureVisible(off.x + 100, off.y + 100, W, H, [MON]);
    assert.ok(f.x + W <= MON.width, `x ${f.x}`);
  });
});

describe("edge snapping", () => {
  it("snaps within the threshold", () => {
    const s = snapToEdge(1920 - W - 10, 400, W, H, MON, 24);
    assert.deepEqual(s.snapped, ["right"]);
    assert.equal(s.x, 1920 - W);
  });

  it("does not snap beyond the threshold", () => {
    const s = snapToEdge(1920 - W - 100, 400, W, H, MON, 24);
    assert.deepEqual(s.snapped, []);
  });

  it("snaps to corners when both edges are close", () => {
    const s = snapToEdge(1920 - W - 5, 1080 - H - 5, W, H, MON, 24);
    assert.ok(s.snapped.includes("right") && s.snapped.includes("bottom"));
  });
});

describe("natural appearances", () => {
  it("rotates among enabled positions without repeating", () => {
    const enabled = ["bottom-right", "right", "top-right"] as const;
    let cur: PositionPreset = "bottom-right";
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) {
      cur = nextNaturalPosition(cur, [...enabled]);
      seen.add(cur);
    }
    assert.ok(seen.size > 1, "rotates");
  });

  it("never picks outside the enabled list", () => {
    for (let i = 0; i < 50; i++) {
      const n = nextNaturalPosition("bottom-right", ["top", "bottom"]);
      assert.ok(n === "top" || n === "bottom");
    }
  });

  it("stays on the current position when it is the only enabled one", () => {
    assert.equal(nextNaturalPosition("top", ["top"]), "top");
  });

  it("keeps the current position when the list is empty", () => {
    assert.equal(nextNaturalPosition("top", []), "top");
  });
});

describe("reduced motion", () => {
  it("replaces showy entrances with fade/instant when reduced or off", () => {
    assert.equal(effectiveEntrance("bounce", "reduced"), "fade");
    assert.equal(effectiveEntrance("pop", "reduced"), "instant");
    assert.equal(effectiveEntrance("slide", "reduced"), "fade");
    assert.equal(effectiveEntrance("pop", "off"), "instant");
    assert.equal(effectiveEntrance("gentle", "reduced"), "fade");
    assert.equal(effectiveEntrance("fade", "reduced"), "fade");
    assert.equal(effectiveEntrance("slide", "full"), "slide");
    assert.equal(effectiveEntrance("gentle", "full"), "gentle");
  });

  it("replaces showy exits with fade/instant when reduced or off", () => {
    assert.equal(effectiveExit("slide", "reduced"), "fade");
    assert.equal(effectiveExit("retreat", "reduced"), "fade");
    assert.equal(effectiveExit("peek-out", "off"), "instant");
    assert.equal(effectiveExit("retreat", "full"), "retreat");
  });
});

describe("idle presence", () => {
  it("maps idle modes to visible fractions", () => {
    assert.equal(visibleFracForIdle("visible", 0.35), 1);
    assert.equal(visibleFracForIdle("mostly-visible", 0.35), 0.85);
    assert.equal(visibleFracForIdle("partially-hidden", 0.35), 0.5);
    assert.equal(visibleFracForIdle("peek-from-edge", 0.35), 0.35);
    assert.equal(visibleFracForIdle("hidden", 0.35), 0);
    assert.equal(visibleFracForIdle("gentle-idle", 0.35), 1);
  });

  it("clamps the peek-from-edge amount", () => {
    assert.equal(visibleFracForIdle("peek-from-edge", 2), 1);
    assert.equal(visibleFracForIdle("peek-from-edge", 0), 0.05);
  });

  it("positions the settings preview on a mini desktop", () => {
    const p = stagePositionFor("bottom-right");
    assert.ok(p.left.endsWith("%") && p.top.endsWith("%"));
    const c = stagePositionFor("center");
    assert.notDeepEqual(c, p);
  });
});

describe("nearest preset", () => {
  it("finds the closest preset for a dragged position", () => {
    const p = nearestPreset(1920 - W - 20, 1080 - H - 20, W, H, MON, EDGE);
    assert.equal(p, "bottom-right");
    const q = nearestPreset(20, 20, W, H, MON, EDGE);
    assert.equal(q, "top-left");
  });
});
