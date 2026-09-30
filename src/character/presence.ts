// Character presence & positioning (spec 33-57).
//
// Pure helpers — no Tauri imports — so node --test can cover them.
// App.tsx performs the actual window calls; the settings page reuses the
// stage math for its live preview.
//
// Coordinates are physical pixels unless noted. The companion window is a
// small transparent Tauri window; "peeking" is done by placing it partly
// offscreen, which is what makes Nila feel physically present at an edge.

import type {
  EntranceBehavior,
  ExitBehavior,
  IdlePresence,
  PositionPreset,
} from "../lib/types";
import type { MonitorRect, Xy } from "../lib/windowPlacement";

/** Presence state machine (spec 54). Transitions are driven by App.tsx. */
export type PresencePhase =
  | "IDLE"
  | "PEEKING"
  | "ENTERING"
  | "VISIBLE"
  | "REMINDING"
  | "INTERACTING"
  | "EXITING"
  | "HIDDEN";

export type Edge = "top" | "bottom" | "left" | "right";
export type BubbleSide = "left" | "right" | "above" | "below";

/** Which edge(s) a preset sits on. Corners report both. */
export function presetEdges(p: PositionPreset): Edge[] {
  switch (p) {
    case "top-left": return ["top", "left"];
    case "top": return ["top"];
    case "top-right": return ["top", "right"];
    case "left": return ["left"];
    case "center": return [];
    case "right": return ["right"];
    case "bottom-left": return ["bottom", "left"];
    case "bottom": return ["bottom"];
    case "bottom-right": return ["bottom", "right"];
  }
}

/** Where the reminder bubble goes relative to Nila (spec 46). */
export function bubbleSideFor(p: PositionPreset): BubbleSide {
  const edges = presetEdges(p);
  if (edges.includes("right")) return "left";
  if (edges.includes("left")) return "right";
  if (edges.includes("top")) return "below";
  return "above"; // bottom + center
}

/**
 * Orientation so Nila faces the desktop (spec 48). The art is front-facing,
 * so only safe mirror/vertical transforms are used — never distortion.
 * Applied to the character image only; bubbles and controls stay upright.
 */
export function orientationFor(
  preset: PositionPreset,
  topHang: boolean,
): { scaleX: 1 | -1; scaleY: 1 | -1 } {
  const edges = presetEdges(preset);
  if (topHang && edges.includes("top")) return { scaleX: 1, scaleY: -1 };
  if (edges.includes("right")) return { scaleX: -1, scaleY: 1 };
  return { scaleX: 1, scaleY: 1 };
}

/** Tilt only makes sense when peeking from a side edge (spec 36). */
export function tiltApplies(preset: PositionPreset): boolean {
  const edges = presetEdges(preset);
  return edges.includes("left") || edges.includes("right");
}

/**
 * CSS transform for the character image: safe orientation + subtle tilt
 * (spec 36/48). Applied to the image only — bubbles and controls are
 * never transformed.
 */
export function characterTransformCSS(
  preset: PositionPreset,
  topHang: boolean,
  tilt: number,
): string {
  const o = orientationFor(preset, topHang);
  const parts: string[] = [];
  if (o.scaleX === -1) parts.push("scaleX(-1)");
  if (o.scaleY === -1) parts.push("scaleY(-1)");
  // Subtle tilt only (spec 37): hard-clamped to -8°…+8°.
  const t = Math.min(8, Math.max(-8, tilt));
  if (tiltApplies(preset) && t !== 0) parts.push(`rotate(${t}deg)`);
  return parts.join(" ") || "none";
}

/** How much of Nila stays onscreen for an idle presence mode. */
export function visibleFracForIdle(idle: IdlePresence, peekAmount: number): number {
  switch (idle) {
    case "visible": return 1;
    case "mostly-visible": return 0.85;
    case "partially-hidden": return 0.5;
    case "peek-from-edge": return Math.min(1, Math.max(0.05, peekAmount));
    case "hidden": return 0;
    case "gentle-idle": return 1;
  }
}

export interface PresetRectOpts {
  preset: PositionPreset;
  monitor: MonitorRect;
  winW: number;
  winH: number;
  /** Pixel inset from the edge. */
  edgeOffset: number;
  /** Fraction of the window kept onscreen (1 = fully inside). */
  visibleFrac: number;
}

/**
 * Window top-left for a preset. Edge presets shift partly offscreen when
 * visibleFrac < 1, so Nila can "stand just outside the desktop looking in"
 * (spec 35).
 */
export function windowRectForPreset(o: PresetRectOpts): Xy {
  const { preset, monitor: m, winW, winH, edgeOffset: e } = o;
  const edges = presetEdges(preset);
  let x = m.x;
  let y = m.y;
  if (!edges.includes("left") && !edges.includes("right")) {
    x = m.x + Math.round((m.width - winW) / 2); // horizontal center
  } else if (edges.includes("right")) {
    x = m.x + m.width - winW - e;
  } else {
    x = m.x + e;
  }
  if (!edges.includes("top") && !edges.includes("bottom")) {
    y = m.y + Math.round((m.height - winH) / 2); // vertical center
  } else if (edges.includes("bottom")) {
    y = m.y + m.height - winH - e;
  } else {
    y = m.y + e;
  }
  // Peek: slide the window off its edge(s) so only visibleFrac remains.
  const hidden = 1 - Math.min(1, Math.max(0, o.visibleFrac));
  if (edges.includes("right")) x += Math.round(winW * hidden);
  if (edges.includes("left")) x -= Math.round(winW * hidden);
  if (edges.includes("bottom")) y += Math.round(winH * hidden);
  if (edges.includes("top")) y -= Math.round(winH * hidden);
  return { x, y };
}

/**
 * Where a "slide" entrance starts: just offscreen in the entrance
 * direction (spec 38). Center slides up from the bottom.
 */
export function slideStartFor(o: Omit<PresetRectOpts, "visibleFrac">): Xy {
  const target = windowRectForPreset({ ...o, visibleFrac: 1 });
  const { monitor: m, winW, winH } = o;
  const edges = presetEdges(o.preset);
  const pad = 16;
  if (edges.includes("right")) return { x: m.x + m.width + pad, y: target.y };
  if (edges.includes("left")) return { x: m.x - winW - pad, y: target.y };
  if (edges.includes("top")) return { x: target.x, y: m.y - winH - pad };
  return { x: target.x, y: m.y + m.height + pad }; // bottom + center
}

/**
 * Keep a window at least minVisible px onscreen (spec 42/43). If it is
 * entirely off every monitor, move it to the bottom-right of the first
 * monitor. Returns the corrected top-left.
 */
export function ensureVisible(
  x: number,
  y: number,
  w: number,
  h: number,
  mons: MonitorRect[],
  minVisible = 64,
): Xy {
  if (mons.length === 0) return { x, y };
  // Monitor with the largest overlap wins.
  let best: MonitorRect | null = null;
  let bestArea = 0;
  for (const m of mons) {
    const ox = Math.max(0, Math.min(x + w, m.x + m.width) - Math.max(x, m.x));
    const oy = Math.max(0, Math.min(y + h, m.y + m.height) - Math.max(y, m.y));
    if (ox * oy > bestArea) {
      bestArea = ox * oy;
      best = m;
    }
  }
  const m = best ?? mons[0];
  if (bestArea === 0) {
    // Fully outside: bottom-right of the fallback monitor.
    return { x: m.x + m.width - w - 16, y: m.y + m.height - h - 16 };
  }
  let nx = x;
  let ny = y;
  if (nx + w < m.x + minVisible) nx = m.x + minVisible - w;
  if (nx > m.x + m.width - minVisible) nx = m.x + m.width - minVisible;
  if (ny + h < m.y + minVisible) ny = m.y + minVisible - h;
  if (ny > m.y + m.height - minVisible) ny = m.y + m.height - minVisible;
  return { x: Math.round(nx), y: Math.round(ny) };
}

export interface SnapResult extends Xy {
  snapped: Edge[];
}

/**
 * Gentle edge snap for manual dragging (spec 45): magnetic, not
 * aggressive. Only the nearest edge per axis snaps, within threshold.
 */
export function snapToEdge(
  x: number,
  y: number,
  w: number,
  h: number,
  monitor: MonitorRect,
  threshold: number,
): SnapResult {
  const snapped: Edge[] = [];
  let nx = x;
  let ny = y;
  if (threshold > 0) {
    const dLeft = Math.abs(x - monitor.x);
    const dRight = Math.abs(monitor.x + monitor.width - (x + w));
    const dTop = Math.abs(y - monitor.y);
    const dBottom = Math.abs(monitor.y + monitor.height - (y + h));
    if (dLeft <= threshold && dLeft <= dRight) {
      nx = monitor.x;
      snapped.push("left");
    } else if (dRight <= threshold) {
      nx = monitor.x + monitor.width - w;
      snapped.push("right");
    }
    if (dTop <= threshold && dTop <= dBottom) {
      ny = monitor.y;
      snapped.push("top");
    } else if (dBottom <= threshold) {
      ny = monitor.y + monitor.height - h;
      snapped.push("bottom");
    }
  }
  return { x: Math.round(nx), y: Math.round(ny), snapped };
}

/**
 * Controlled randomness for natural appearances (spec 41): pick a random
 * enabled position that isn't the current one. Never fully random — the
 * enabled list is always respected, and the user can switch it off.
 */
export function nextNaturalPosition(
  current: PositionPreset,
  enabled: PositionPreset[],
  rand: () => number = Math.random,
): PositionPreset {
  const pool = enabled.filter((p) => p !== current);
  if (pool.length === 0) return enabled.length > 0 ? enabled[0] : current;
  return pool[Math.floor(rand() * pool.length)];
}

export type EffectiveEntrance = EntranceBehavior | "instant";

/** Reduced motion (spec 56): slide/bounce/pop become fade/instant. */
export function effectiveEntrance(
  entrance: EntranceBehavior,
  motion: "full" | "reduced" | "off",
): EffectiveEntrance {
  if (motion === "off") return "instant";
  if (motion === "reduced") {
    switch (entrance) {
      case "slide":
      case "bounce":
      case "peek":
      case "gentle":
      case "fade":
        return "fade";
      case "pop":
        return "instant";
    }
  }
  return entrance;
}

export type EffectiveExit = ExitBehavior | "instant";

export function effectiveExit(
  exit: ExitBehavior,
  motion: "full" | "reduced" | "off",
): EffectiveExit {
  if (motion === "off") return "instant";
  if (motion === "reduced") return "fade";
  return exit;
}

export interface ReminderLayout {
  x: number;
  y: number;
  w: number;
  h: number;
  side: BubbleSide;
  /** Character box inside the window (logical px). */
  charX: number;
  charY: number;
}

/**
 * Reminder window: character stays at her preset anchor, the bubble opens
 * toward the desktop and the whole window is clamped onscreen (spec 46/47).
 * All sizes in the same units (logical or physical — caller decides).
 */
export function reminderWindowRect(o: {
  preset: PositionPreset;
  monitor: MonitorRect;
  charW: number;
  charH: number;
  bubbleW: number;
  bubbleH: number;
  edgeOffset: number;
  gap?: number;
}): ReminderLayout {
  const gap = o.gap ?? 12;
  const side = bubbleSideFor(o.preset);
  const anchor = windowRectForPreset({
    preset: o.preset,
    monitor: o.monitor,
    winW: o.charW,
    winH: o.charH,
    edgeOffset: o.edgeOffset,
    visibleFrac: 1,
  });
  let w: number;
  let h: number;
  let x: number;
  let y: number;
  let charX: number;
  let charY: number;
  if (side === "left" || side === "right") {
    w = o.charW + gap + o.bubbleW;
    h = Math.max(o.charH, o.bubbleH);
    charY = Math.round((h - o.charH) / 2);
    if (side === "left") {
      // Bubble opens toward the desktop (left of Nila).
      x = anchor.x - gap - o.bubbleW;
      charX = gap + o.bubbleW;
    } else {
      x = anchor.x;
      charX = 0;
    }
    y = Math.round(anchor.y - (h - o.charH) / 2);
  } else {
    w = Math.max(o.charW, o.bubbleW);
    h = o.charH + gap + o.bubbleH;
    charX = Math.round((w - o.charW) / 2);
    if (side === "above") {
      y = anchor.y - gap - o.bubbleH;
      charY = gap + o.bubbleH;
    } else {
      y = anchor.y;
      charY = 0;
    }
    x = Math.round(anchor.x - (w - o.charW) / 2);
  }
  const fixed = ensureVisible(x, y, w, h, [o.monitor]);
  return { x: fixed.x, y: fixed.y, w, h, side, charX, charY };
}

/** Mini-desktop preview math for the settings page (percentages). */
export function stagePositionFor(preset: PositionPreset): { left: string; top: string } {
  const edges = presetEdges(preset);
  const h = edges.includes("left") ? "6%" : edges.includes("right") ? "88%" : "47%";
  const v = edges.includes("top") ? "8%" : edges.includes("bottom") ? "76%" : "42%";
  return { left: h, top: v };
}

/**
 * Nearest preset to a free (dragged) position — used for bubble side and
 * orientation when Nila isn't on a preset (spec 43/46/48).
 */
export function nearestPreset(
  x: number,
  y: number,
  w: number,
  h: number,
  monitor: MonitorRect,
  edgeOffset: number,
): PositionPreset {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const presets: PositionPreset[] = [
    "top-left", "top", "top-right",
    "left", "center", "right",
    "bottom-left", "bottom", "bottom-right",
  ];
  let best: PositionPreset = "bottom-right";
  let bestD = Infinity;
  for (const p of presets) {
    const r = windowRectForPreset({
      preset: p,
      monitor,
      winW: w,
      winH: h,
      edgeOffset,
      visibleFrac: 1,
    });
    const d = Math.hypot(r.x + w / 2 - cx, r.y + h / 2 - cy);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}
