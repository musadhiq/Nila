import { useEffect, useRef, useState } from "react";
import {
  availableMonitors,
  currentMonitor,
  getCurrentWindow,
  LogicalSize,
  PhysicalPosition,
  primaryMonitor,
  type Monitor,
} from "@tauri-apps/api/window";
import { CharacterEngine, NilaCharacter } from "./character";
import type { CharacterSnapshot } from "./character";
import type { ExpressionName } from "./character/expressions";
import {
  bubbleSideFor,
  characterTransformCSS,
  effectiveEntrance,
  effectiveExit,
  ensureVisible,
  nearestPreset,
  nextNaturalPosition,
  presetEdges,
  reminderWindowRect,
  slideStartFor,
  snapToEdge,
  visibleFracForIdle,
  windowRectForPreset,
  type BubbleSide,
  type ReminderLayout,
} from "./character/presence";
import { ONBOARDING } from "./lib/strings";
import { getStrings } from "./lib/i18n";
import type { AppSettings, PositionPreset, Reminder, ReminderKind, Schedule } from "./lib/types";
import { DEFAULT_SETTINGS } from "./lib/types";
import {
  BUILT_IN_TEMPLATES,
  mergeSettings,
  scheduleToJson,
  settingsToRecord,
  toReminder,
  type ReminderDto,
} from "./lib/reminders";
import { invokeCommand, isTauri, listenEvent } from "./lib/tauri";
import { playReminderChime } from "./lib/sound";
import {
  glidePosition,
  isOnAnyMonitor,
  loadSavedPosition,
  type MonitorRect,
  type Xy,
} from "./lib/windowPlacement";
import { ReminderOverlay, type DueReminder } from "./components/ReminderOverlay";
import { SettingsPanel } from "./components/SettingsPanel";
import { IconGeneral } from "./components/settings/icons";
import type { ReminderInput } from "./components/settings/ReminderEditor";

type View = "companion" | "settings";

const REMINDER_KINDS = ["water", "food", "break", "move", "sleep", "custom"] as const;

function isPausedSettings(s: AppSettings): boolean {
  if (!s.paused_until) return false;
  const t = Date.parse(s.paused_until);
  return Number.isFinite(t) && t > Date.now();
}

/**
 * Nila companion window: floating transparent window with the character.
 * Listens for REMINDER_DUE from the Rust scheduler and shows the
 * reminder overlay; gear button opens settings / reminder management.
 */
export default function App() {
  const engineRef = useRef<CharacterEngine | null>(null);
  if (!engineRef.current) engineRef.current = new CharacterEngine();
  const [snap, setSnap] = useState<CharacterSnapshot>(() => engineRef.current!.snapshot());
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [view, setView] = useState<View>("companion");
  const [activeReminder, setActiveReminder] = useState<DueReminder | null>(null);
  const [paused, setPaused] = useState(false);
  const [greeted, setGreeted] = useState(false);
  /** True while the settings panel uses native OS window decorations
   *  (titlebar + resize handles). The custom titlebar hides then. */
  const [decorated, setDecorated] = useState(false);
  // Presence state.
  const [enterAnim, setEnterAnim] = useState<string | null>(null);
  const [stageFading, setStageFading] = useState(false);
  const [charTransform, setCharTransform] = useState("none");
  /** Ground shadow under Nila — only when she's anchored to the bottom edge
   *  (never for side peeks or top hanging). Updated with the transform. */
  const [showGroundShadow, setShowGroundShadow] = useState(true);
  const [bubbleSide, setBubbleSide] = useState<BubbleSide>("above");
  const enterAnimTimer = useRef<number | null>(null);
  // The preset Nila is currently using (may differ from the setting when
  // natural appearances pick another enabled position).
  const activePresetRef = useRef<PositionPreset>("bottom-right");
  // Last reminder window layout, so a "retreat" exit can shrink back
  // around the character without her jumping.
  const reminderLayoutRef = useRef<ReminderLayout | null>(null);

  // Window lifecycle: Nila lives in the menu-bar tray. The floating window
  // only appears when a reminder is due, or when opened from the tray.
  // `manualOpen` tracks a user-opened window so reminder dismissal doesn't
  // hide a window the user asked to see.
  const manualOpenRef = useRef(false);
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  // Pending delayed hide (lets an expression beat play before Nila slips
  // back into the tray); cancelled when a new reminder fires.
  const pendingHideRef = useRef<number | null>(null);
  // A due reminder waiting for the user to click Nila ("character" mode).
  const pendingReminderRef = useRef<DueReminder | null>(null);
  // Fresh settings inside event handlers (the REMINDER_DUE listener is
  // registered once but needs the current sound/motion choices).
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const downPos = useRef<{ x: number; y: number } | null>(null);

  const COMPANION_W = 220;
  const COMPANION_H = 300;
  // Premium two-column settings window (works at 900x600 and up; the
  // sidebar collapses to an icon rail in narrower windows).
  const PANEL_W = 960;
  const PANEL_H = 640;

  /**
   * Window chrome per view. The companion is a small always-on-top
   * frameless sprite; settings is a real resizable desktop window
   * (with its own custom titlebar, since decorations are off).
   */
  const setPanelChrome = async (panel: boolean) => {
    if (!isTauri()) return;
    try {
      const win = getCurrentWindow();
      // Do NOT toggle setResizable(): on GNOME/Wayland the compositor
      // ignores runtime resizable changes on an undecorated window and
      // keeps clamping to the creation size. Instead the window is born
      // resizable (tauri.conf) but locked via min/max; here we just move
      // the locks. We also use NATIVE decorations for the settings panel:
      // an undecorated window on Wayland gets no working resize handles
      // and startDragging() is unreliable, while the compositor's own
      // titlebar drags and resizes correctly.
      if (panel) {
        // Settings: a real resizable desktop window with native chrome.
        await win.setDecorations(true);
        await win.setMaxSize(null);
        await win.setMinSize(new LogicalSize(720, 480));
        setDecorated(true);
      } else {
        // Companion: frameless sprite, locked to the small size.
        await win.setDecorations(false);
        await win.setMinSize(new LogicalSize(COMPANION_W, COMPANION_H));
        await win.setMaxSize(new LogicalSize(COMPANION_W, COMPANION_H));
        setDecorated(false);
      }
      await win.setAlwaysOnTop(!panel);
    } catch {
      /* ignore */
    }
  };

  const resizeWindow = async (w: number, h: number) => {
    if (!isTauri()) return;
    try {
      await getCurrentWindow().setSize(new LogicalSize(w, h));
    } catch {
      /* ignore */
    }
  };

  const showAppWindow = async () => {
    if (!isTauri()) return;
    try {
      const win = getCurrentWindow();
      await win.show();
      await win.setFocus();
    } catch {
      /* ignore */
    }
  };

  const hideAppWindow = async () => {
    if (!isTauri()) return;
    try {
      await getCurrentWindow().hide();
    } catch {
      /* ignore */
    }
  };

  // Momentary expression faces (character/expressions/): a new flash always
  // cancels the previous one so beats never overlap or cut each other short.
  const exprTimers = useRef<number[]>([]);
  const flashExpression = (name: ExpressionName, ms: number) => {
    exprTimers.current.forEach((t) => window.clearTimeout(t));
    exprTimers.current = [];
    engineRef.current!.showExpression(name);
    exprTimers.current.push(
      window.setTimeout(() => engineRef.current!.clearExpression(), ms),
    );
  };

  /** Soft notification chime on reminder, honoring the sound setting. */
  const chimeForReminder = () => {
    const s = settingsRef.current.sound;
    if (s !== "none") playReminderChime(s);
  };

  const toMonitorRect = (m: Monitor): MonitorRect => ({
    x: m.position.x,
    y: m.position.y,
    width: m.size.width,
    height: m.size.height,
  });

  /**
   * Presence controller (spec 33-57). Nila's window position is computed
   * from her presence settings — preset, monitor, idle behavior, peek
   * amount, edge offset. A user-dragged position (presence_pos) wins over
   * the preset until the monitor setup changes.
   */

  /** Monitors as physical-pixel rects with per-monitor scale factors. */
  const monitorInfo = async (): Promise<{
    rects: MonitorRect[];
    scales: number[];
    primary: number;
  }> => {
    const mons = await availableMonitors().catch((): Monitor[] => []);
    const rects = mons.map(toMonitorRect);
    const win = getCurrentWindow();
    const winScale = await win.scaleFactor().catch(() => 1);
    const scales = mons.map((m) => {
      const s = (m as unknown as { scaleFactor?: number }).scaleFactor;
      return typeof s === "number" && s > 0 ? s : winScale;
    });
    let primary = 0;
    try {
      const p = await primaryMonitor().catch(() => null);
      if (p) {
        const i = mons.findIndex(
          (m) => m.position.x === p.position.x && m.position.y === p.position.y,
        );
        if (i >= 0) primary = i;
      }
    } catch {
      /* ignore */
    }
    return { rects, scales, primary };
  };

  /** Which monitor Nila appears on (spec 42). */
  const pickMonitorIndex = async (info: {
    rects: MonitorRect[];
    primary: number;
  }): Promise<number> => {
    const s = settingsRef.current;
    const n = info.rects.length;
    if (n === 0) return 0;
    switch (s.monitor_mode) {
      case "main":
        return info.primary;
      case "current": {
        const cur = await currentMonitor().catch(() => null);
        if (cur) {
          const i = info.rects.findIndex(
            (r) => r.x === cur.position.x && r.y === cur.position.y,
          );
          if (i >= 0) return i;
        }
        return info.primary;
      }
      case "remember": {
        const saved = s.presence_pos;
        if (saved && saved.monitor >= 0 && saved.monitor < n) return saved.monitor;
        return info.primary;
      }
      case "specific":
        return s.monitor_index >= 0 && s.monitor_index < n
          ? s.monitor_index
          : info.primary;
    }
  };

  /** Where the companion window rests when idle (physical px). */
  const resolveIdleTarget = async (): Promise<{
    x: number;
    y: number;
    preset: PositionPreset;
    monitor: number;
  } | null> => {
    const s = settingsRef.current;
    const info = await monitorInfo();
    if (info.rects.length === 0) return null;
    const mi = await pickMonitorIndex(info);
    const mon = info.rects[mi];
    const scale = info.scales[mi] ?? 1;
    const winW = Math.round(COMPANION_W * scale);
    const winH = Math.round(COMPANION_H * scale);
    // A user-dragged position wins — unless the monitor setup changed.
    const saved = s.presence_pos;
    if (
      saved &&
      saved.monitor === mi &&
      isOnAnyMonitor({ x: saved.x, y: saved.y }, info.rects)
    ) {
      const fixed = ensureVisible(saved.x, saved.y, winW, winH, info.rects);
      return {
        ...fixed,
        preset: nearestPreset(
          fixed.x,
          fixed.y,
          winW,
          winH,
          mon,
          Math.round(s.edge_offset * scale),
        ),
        monitor: mi,
      };
    }
    let preset = s.position_preset;
    if (s.natural_appearances && s.enabled_positions.length > 0) {
      preset = nextNaturalPosition(activePresetRef.current, s.enabled_positions);
    }
    activePresetRef.current = preset;
    const frac = visibleFracForIdle(s.idle_presence, s.peek_amount);
    const pos = windowRectForPreset({
      preset,
      monitor: mon,
      winW,
      winH,
      edgeOffset: Math.round(s.edge_offset * scale),
      visibleFrac: frac,
    });
    return { ...pos, preset, monitor: mi };
  };

  /** Orientation + tilt for the character image (never the bubble). */
  const applyCharTransform = (preset: PositionPreset) => {
    const s = settingsRef.current;
    setCharTransform(characterTransformCSS(preset, s.top_hang, s.tilt));
    // Ground shadow only when Nila stands on the bottom edge.
    setShowGroundShadow(preset === "bottom-left" || preset === "bottom" || preset === "bottom-right");
  };

  /** CSS entrance class for the stage; null when the window glides instead. */
  const entranceClassFor = (kind: string): string | null => {
    switch (kind) {
      case "fade":
        return "nila-enter-fade";
      case "pop":
        return "nila-enter-pop";
      case "bounce":
        return "nila-enter-bounce";
      case "gentle":
        return "nila-enter-gentle";
      default:
        return null; // slide + peek glide the window itself
    }
  };

  /** Send Nila back to the tray (used when closing panels). */
  const hideToTray = () => {
    manualOpenRef.current = false;
    pendingReminderRef.current = null;
    reminderLayoutRef.current = null;
    setActiveReminder(null);
    setView("companion");
    void setPanelChrome(false);
    void seatCompanion();
    // "Always visible" keeps Nila on screen: closing settings just
    // returns to the companion instead of hiding to the tray.
    if (settingsRef.current.character_visibility === "always") {
      void presentCompanion("idle");
    } else {
      void hideAppWindow();
    }
  };

  /** After a reminder is handled, Nila leaves with her exit behavior. */
  const maybeHideAfterReminder = () => {
    if (manualOpenRef.current) return;
    void dismissCompanion();
  };

  /**
   * Let an expression beat play (proud/sleepy), then send Nila away with
   * her configured exit behavior — unless the user opened the window.
   */
  const exitAfterBeat = (ms: number) => {
    if (manualOpenRef.current) return;
    if (pendingHideRef.current !== null) window.clearTimeout(pendingHideRef.current);
    pendingHideRef.current = window.setTimeout(() => {
      pendingHideRef.current = null;
      if (!manualOpenRef.current) void dismissCompanion();
    }, ms);
  };

  /**
   * Reveal the companion using the configured presence (spec 47/54):
   * position, entrance behavior, orientation, tilt.
   */
  const presentCompanion = async (mode: "idle" | "reminder" = "idle") => {
    if (!isTauri()) return;
    const win = getCurrentWindow();
    const s = settingsRef.current;
    try {
      await setPanelChrome(false);
      const target = await resolveIdleTarget();
      if (!target) {
        await win.show();
        return;
      }
      applyCharTransform(target.preset);
      const info = await monitorInfo();
      const mon = info.rects[target.monitor];
      const scale = info.scales[target.monitor] ?? 1;
      const winW = Math.round(COMPANION_W * scale);
      const winH = Math.round(COMPANION_H * scale);
      const eo = Math.round(s.edge_offset * scale);
      await win.setSize(new LogicalSize(COMPANION_W, COMPANION_H));
      const entrance = effectiveEntrance(s.entrance, s.animation);
      const cls = entranceClassFor(entrance);
      const ms = s.entrance_ms;
      if (entrance === "slide" || entrance === "peek") {
        const start =
          entrance === "slide"
            ? slideStartFor({ preset: target.preset, monitor: mon, winW, winH, edgeOffset: eo })
            : windowRectForPreset({
                preset: target.preset,
                monitor: mon,
                winW,
                winH,
                edgeOffset: eo,
                visibleFrac: 0.06,
              });
        await win.setPosition(new PhysicalPosition(start.x, start.y));
        await win.show();
        await glidePosition(start, { x: target.x, y: target.y }, ms, (x, y) => {
          void win.setPosition(new PhysicalPosition(x, y)).catch(() => {});
        });
      } else {
        await win.setPosition(new PhysicalPosition(target.x, target.y));
        await win.show();
        if (cls && entrance !== "instant") {
          if (enterAnimTimer.current !== null) window.clearTimeout(enterAnimTimer.current);
          setEnterAnim(cls);
          enterAnimTimer.current = window.setTimeout(() => {
            enterAnimTimer.current = null;
            setEnterAnim(null);
          }, ms + 80);
        }
      }
      await win.setFocus().catch(() => {});
      // Idle presence "hidden": Nila slips away right after arriving —
      // unless she is meant to stay visible anyway.
      if (
        mode === "idle" &&
        s.idle_presence === "hidden" &&
        s.character_visibility !== "always"
      ) {
        exitAfterBeat(Math.max(500, ms + 300));
      }
    } catch {
      try {
        await win.show();
      } catch {
        /* ignore */
      }
    }
  };

  /** Seat Nila at her presence spot without any entrance animation. */
  const seatCompanion = async () => {
    if (!isTauri()) return;
    const target = await resolveIdleTarget();
    if (!target) return;
    applyCharTransform(target.preset);
    try {
      const win = getCurrentWindow();
      await win.setSize(new LogicalSize(COMPANION_W, COMPANION_H));
      await win.setPosition(new PhysicalPosition(target.x, target.y));
    } catch {
      /* ignore */
    }
  };

  /** Send Nila away using the configured exit behavior (spec 39). */
  const dismissCompanion = async () => {
    if (!isTauri()) return;
    const win = getCurrentWindow();
    const s = settingsRef.current;
    if (manualOpenRef.current) return;
    if (s.character_visibility === "always") {
      // Always-visible: retreat to the idle spot instead of hiding.
      await presentCompanion("idle");
      return;
    }
    const exit = effectiveExit(s.exit_behavior, s.animation);
    const ms = s.exit_ms;
    try {
      if (exit === "fade" || exit === "instant") {
        if (exit === "fade" && ms > 0) {
          setStageFading(true);
          await new Promise((r) => window.setTimeout(r, Math.min(ms, 400)));
          setStageFading(false);
        }
        await win.hide();
        return;
      }
      const target = await resolveIdleTarget();
      const from = await win.outerPosition().catch(() => null);
      const size = await win.outerSize().catch(() => null);
      if (!target || !from || !size) {
        await win.hide();
        return;
      }
      const info = await monitorInfo();
      const mon = info.rects[target.monitor];
      const scale = info.scales[target.monitor] ?? 1;
      const eo = Math.round(s.edge_offset * scale);
      let start: Xy = { x: from.x, y: from.y };
      const rl = reminderLayoutRef.current;
      if (rl && exit === "retreat") {
        // Shrink the reminder window back around the character first, so
        // she doesn't jump when the bubble goes away.
        const charScrX = Math.round(from.x + rl.charX * scale);
        const charScrY = Math.round(from.y + rl.charY * scale);
        await win.setSize(new LogicalSize(COMPANION_W, COMPANION_H));
        await win.setPosition(new PhysicalPosition(charScrX, charScrY));
        start = { x: charScrX, y: charScrY };
      }
      reminderLayoutRef.current = null;
      let to: Xy;
      if (exit === "slide") {
        // Back to the place she came from: offscreen in the edge direction.
        to = slideStartFor({
          preset: target.preset,
          monitor: mon,
          winW: size.width,
          winH: size.height,
          edgeOffset: eo,
        });
      } else if (exit === "peek-out") {
        to = windowRectForPreset({
          preset: target.preset,
          monitor: mon,
          winW: size.width,
          winH: size.height,
          edgeOffset: eo,
          visibleFrac: 0.06,
        });
      } else {
        // Retreat to the idle spot.
        to = { x: target.x, y: target.y };
      }
      await glidePosition(start, to, ms, (x, y) => {
        void win.setPosition(new PhysicalPosition(x, y)).catch(() => {});
      });
      // Retreat keeps her resting at the idle spot when idle presence
      // is visible; otherwise she slips out of sight.
      if (exit === "retreat" && s.idle_presence !== "hidden") {
        await win.setSize(new LogicalSize(COMPANION_W, COMPANION_H));
        return;
      }
      await win.hide();
    } catch {
      try {
        await win.hide();
      } catch {
        /* ignore */
      }
    }
  };

  // Reminder bubble box (logical px). The card is capped so the bubble
  // can never outgrow the screen (spec 46).
  const BUBBLE_W = 300;
  const BUBBLE_H = 280;
  const REM_GAP = 12;
  const REM_PAD = 16;

  /**
   * Show a reminder: Nila appears at her spot and the bubble opens toward
   * the desktop, clamped onscreen (spec 46/47).
   */
  const presentReminder = async (r: DueReminder) => {
    if (!isTauri()) return;
    const win = getCurrentWindow();
    const s = settingsRef.current;
    try {
      await setPanelChrome(false);
      const target = await resolveIdleTarget();
      const info = await monitorInfo();
      if (!target || info.rects.length === 0) {
        setActiveReminder(r);
        await win.show();
        return;
      }
      const mon = info.rects[target.monitor];
      const scale = info.scales[target.monitor] ?? 1;
      applyCharTransform(target.preset);
      const side = bubbleSideFor(target.preset);
      const layout = reminderWindowRect({
        preset: target.preset,
        monitor: {
          x: mon.x / scale,
          y: mon.y / scale,
          width: mon.width / scale,
          height: mon.height / scale,
        },
        charW: COMPANION_W,
        charH: COMPANION_H,
        bubbleW: BUBBLE_W,
        bubbleH: BUBBLE_H,
        edgeOffset: s.edge_offset,
        gap: REM_GAP,
      });
      // Padding around the layout, re-clamped to the monitor.
      const w = layout.w + REM_PAD;
      const h = layout.h + REM_PAD;
      const fixed = ensureVisible(
        layout.x - REM_PAD / 2,
        layout.y - REM_PAD / 2,
        w,
        h,
        [
          {
            x: mon.x / scale,
            y: mon.y / scale,
            width: mon.width / scale,
            height: mon.height / scale,
          },
        ],
      );
      setBubbleSide(side);
      setActiveReminder(r);
      // Remember the character box so a "retreat" exit can shrink the
      // window back around her without her jumping on screen.
      reminderLayoutRef.current = { ...layout, x: fixed.x, y: fixed.y };
      await win.setSize(new LogicalSize(Math.round(w), Math.round(h)));
      const lm = {
        x: mon.x / scale,
        y: mon.y / scale,
        width: mon.width / scale,
        height: mon.height / scale,
      };
      const placeAt = (lx: number, ly: number) => {
        win
          .setPosition(
            new PhysicalPosition(Math.round(lx * scale), Math.round(ly * scale)),
          )
          .catch(() => {});
      };
      const entrance = effectiveEntrance(s.entrance, s.animation);
      const cls = entranceClassFor(entrance);
      const ms = s.entrance_ms;
      if (entrance === "slide" || entrance === "peek") {
        // The whole reminder window glides in from her edge (spec 47).
        const edges = presetEdges(target.preset);
        const pad = 24;
        let sx = fixed.x;
        let sy = fixed.y;
        if (entrance === "slide") {
          if (edges.includes("right")) sx = lm.x + lm.width + pad;
          else if (edges.includes("left")) sx = lm.x - w - pad;
          else if (edges.includes("top")) sy = lm.y - h - pad;
          else sy = lm.y + lm.height + pad; // bottom + center
        } else {
          // Peek: start barely visible at the edge, then emerge.
          const vis = 0.15;
          if (edges.includes("right")) sx = lm.x + lm.width - w * vis;
          else if (edges.includes("left")) sx = lm.x - w * (1 - vis);
          else if (edges.includes("top")) sy = lm.y - h * (1 - vis);
          else sy = lm.y + lm.height - h * vis;
        }
        placeAt(sx, sy);
        await win.show();
        await glidePosition({ x: sx, y: sy }, { x: fixed.x, y: fixed.y }, ms, (x, y) =>
          placeAt(x, y),
        );
      } else {
        placeAt(fixed.x, fixed.y);
        await win.show();
        if (cls && entrance !== "instant") {
          if (enterAnimTimer.current !== null) window.clearTimeout(enterAnimTimer.current);
          setEnterAnim(cls);
          enterAnimTimer.current = window.setTimeout(() => {
            enterAnimTimer.current = null;
            setEnterAnim(null);
          }, ms + 80);
        }
      }
      await win.setFocus().catch(() => {});
    } catch {
      setActiveReminder(r);
      try {
        await win.show();
      } catch {
        /* ignore */
      }
    }
  };

  /** Drag the floating window by the character (Tauri only). */
  const startDrag = (e: React.MouseEvent) => {
    downPos.current = { x: e.clientX, y: e.clientY };
    if (!isTauri() || e.button !== 0) return;
    if (view !== "companion" || activeReminder) return;
    if (!settingsRef.current.draggable) return;
    void getCurrentWindow().startDragging().catch(() => {});
  };

  // Engine -> React state.
  useEffect(() => {
    const off = engineRef.current!.onChange(setSnap);
    return off;
  }, []);

  // Remember Nila's spot (spec 43/44/45): after the user drags her,
  // gently snap to nearby edges, then persist the position through the
  // settings architecture so she returns to the same spot on restart.
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | null = null;
    let timer: number | null = null;
    (async () => {
      try {
        unlisten = await getCurrentWindow().listen("tauri://move", () => {
          if (timer !== null) window.clearTimeout(timer);
          timer = window.setTimeout(() => {
            timer = null;
            void (async () => {
              try {
                const win = getCurrentWindow();
                const pos = await win.outerPosition();
                const size = await win.outerSize().catch(() => null);
                const info = await monitorInfo();
                if (info.rects.length === 0 || !size) return;
                const w = size.width;
                const h = size.height;
                // Which monitor is she on? Use the window center.
                const cx = pos.x + w / 2;
                const cy = pos.y + h / 2;
                let mi = info.rects.findIndex(
                  (r) => cx >= r.x && cx <= r.x + r.width && cy >= r.y && cy <= r.y,
                );
                if (mi < 0) mi = info.primary;
                const s = settingsRef.current;
                const scale = info.scales[mi] ?? 1;
                let x = pos.x;
                let y = pos.y;
                if (s.snap_enabled) {
                  const snapped = snapToEdge(
                    x,
                    y,
                    w,
                    h,
                    info.rects[mi],
                    Math.round(s.snap_threshold * scale),
                  );
                  if (snapped.snapped.length > 0) {
                    await win.setPosition(new PhysicalPosition(snapped.x, snapped.y));
                    x = snapped.x;
                    y = snapped.y;
                  }
                }
                const preset = nearestPreset(
                  x,
                  y,
                  w,
                  h,
                  info.rects[mi],
                  Math.round(s.edge_offset * scale),
                );
                activePresetRef.current = preset;
                applyCharTransform(preset);
                const next = {
                  ...settingsRef.current,
                  presence_pos: { x, y, monitor: mi, preset },
                };
                setSettings(next);
                try {
                  await invokeCommand("update_settings", {
                    settings: settingsToRecord(next),
                  });
                } catch {
                  /* demo mode */
                }
              } catch {
                /* ignore */
              }
            })();
          }, 600);
        });
      } catch {
        /* ignore */
      }
    })();
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // First-launch greeting.
  useEffect(() => {
    const t = window.setTimeout(() => {
      engineRef.current!.wave();
      setGreeted(true);
      window.setTimeout(() => engineRef.current!.returnToIdle(), 2500);
    }, 600);
    // The window starts hidden in the tray; seat it at her presence spot
    // before it first appears so entrances always start right.
    void (async () => {
      if (!isTauri()) return;
      const target = await resolveIdleTarget();
      if (target) {
        activePresetRef.current = target.preset;
        applyCharTransform(target.preset);
        try {
          await getCurrentWindow().setPosition(
            new PhysicalPosition(target.x, target.y),
          );
        } catch {
          /* leave the OS default */
        }
      }
    })();
    return () => window.clearTimeout(t);
  }, []);

  // Load settings + reminders; seed built-ins on first launch.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = await invokeCommand<Record<string, string>>("get_settings");
        if (cancelled) return;
        const merged = mergeSettings(raw);
        let dtos = await invokeCommand<ReminderDto[]>("list_reminders");
        if (cancelled) return;
        if (dtos.length === 0 && !raw.seeded_v1) {
          for (const t of BUILT_IN_TEMPLATES) {
            await invokeCommand("create_reminder", {
              input: {
                title: t.title,
                message: t.message,
                kind: t.kind,
                schedule: scheduleToJson(t.schedule),
                enabled: true,
              },
            });
          }
          await invokeCommand("update_settings", { settings: { seeded_v1: "1" } });
          dtos = await invokeCommand<ReminderDto[]>("list_reminders");
          if (cancelled) return;
        }
        setReminders(dtos.map(toReminder));
        // Migrate the old drag-saved position into the presence store
        // (spec 43): it becomes a user-placed presence_pos.
        if (!merged.presence_pos) {
          const legacy = loadSavedPosition();
          if (legacy) {
            merged.presence_pos = {
              x: legacy.x,
              y: legacy.y,
              monitor: 0,
              preset: "bottom-right",
            };
          }
        }
        setSettings(merged);
        setPaused(isPausedSettings(merged));
        engineRef.current!.setSize(merged.character_size);
        engineRef.current!.setMotion(merged.animation);
        // "Always visible": Nila stays on screen from launch.
        if (merged.character_visibility === "always") void presentCompanion("idle");
      } catch {
        // Demo mode (plain vite): defaults stay, backend calls no-op.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Scheduler -> overlay.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    (async () => {
      unlisten = await listenEvent<unknown>("REMINDER_DUE", (payload) => {
        let r: DueReminder;
        if (typeof payload === "string") {
          r = {
            id: "test",
            title: "Parikshanam",
            message: "Ithu oru parikshana ormmappeduthal aanu 🌸",
            kind: "custom",
          };
        } else if (payload && typeof payload === "object") {
          const p = payload as Record<string, unknown>;
          r = {
            id: String(p.id ?? "unknown"),
            title: String(p.title ?? ""),
            message: String(p.message ?? ""),
            kind: String(p.kind ?? "custom"),
          };
        } else {
          return;
        }
        const kind = (REMINDER_KINDS as readonly string[]).includes(r.kind)
          ? (r.kind as (typeof REMINDER_KINDS)[number])
          : "custom";
        // A new reminder cancels a pending slip-back-to-tray.
        if (pendingHideRef.current !== null) {
          window.clearTimeout(pendingHideRef.current);
          pendingHideRef.current = null;
        }
        const behavior = settingsRef.current.reminder_behavior;
        const hidden = settingsRef.current.character_visibility === "hidden";
        // "Hidden" mode: Nila never appears on screen. The scheduler
        // delivers the reminder as an OS notification instead.
        if (hidden) return;
        // "System notification" mode: the OS notification is the whole
        // surface (sent by the scheduler); Nila stays in the tray.
        if (behavior === "system") return;
        engineRef.current!.beginReminder(kind);
        if (behavior === "character") {
          // "Character only" mode: Nila appears quietly with no overlay.
          // Clicking her reveals the pending reminder; if ignored she
          // slips back into the tray after a while.
          pendingReminderRef.current = r;
          chimeForReminder();
          setView("companion");
          void presentCompanion("idle");
          exitAfterBeat(30000);
          return;
        }
        setView("companion");
        // A reminder is due: Nila appears with her configured entrance,
        // the bubble opening toward the desktop. The overlay takes over
        // the window.
        setActiveReminder(r);
        // She gasps, then points at the reminder bubble.
        flashExpression("surprised", 800);
        exprTimers.current.push(
          window.setTimeout(() => engineRef.current!.showExpression("point"), 800),
          window.setTimeout(() => engineRef.current!.clearExpression(), 1800),
        );
        chimeForReminder();
        void presentReminder(r);
      });
    })();
    return () => {
      unlisten?.();
    };
  }, []);

  const refreshSettings = async () => {
    try {
      const raw = await invokeCommand<Record<string, string>>("get_settings");
      const merged = mergeSettings(raw);
      setSettings(merged);
      setPaused(isPausedSettings(merged));
    } catch {
      /* demo mode */
    }
  };

  // After a backup import: keep the "first launch" seed from re-firing,
  // then reload settings + reminders and apply character options.
  const reloadAfterImport = async () => {
    try {
      await invokeCommand("update_settings", { settings: { seeded_v1: "1" } });
      const raw = await invokeCommand<Record<string, string>>("get_settings");
      const merged = mergeSettings(raw);
      const dtos = await invokeCommand<ReminderDto[]>("list_reminders");
      setSettings(merged);
      setReminders(dtos.map(toReminder));
      setPaused(isPausedSettings(merged));
      engineRef.current!.setSize(merged.character_size);
      engineRef.current!.setMotion(merged.animation);
    } catch {
      /* demo mode */
    }
  };

  const openPanel = async (v: View) => {
    manualOpenRef.current = true;
    if (v === "settings") void refreshSettings();
    setView(v);
    // Sequential on purpose: the window manager must apply the panel
    // chrome and the panel size before the window is (re)shown,
    // otherwise the panel can get stuck at the small sprite size.
    await setPanelChrome(true);
    await resizeWindow(PANEL_W, PANEL_H);
  };

  const minimizeWindow = () => {
    if (!isTauri()) return;
    void getCurrentWindow().minimize().catch(() => {});
  };

  const handleCompanionClick = (e?: React.MouseEvent) => {
    // "Character only" mode: clicking Nila reveals the pending reminder.
    const pending = pendingReminderRef.current;
    if (pending && !activeReminder) {
      pendingReminderRef.current = null;
      engineRef.current!.beginReminder(
        (REMINDER_KINDS as readonly string[]).includes(pending.kind)
          ? (pending.kind as (typeof REMINDER_KINDS)[number])
          : "custom",
      );
      setActiveReminder(pending);
      return;
    }
    if (activeReminder) return;
    // A real drag shouldn't also trigger the wave.
    const d = downPos.current;
    if (e && d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) return;
    const engine = engineRef.current!;
    engine.wave();
    window.setTimeout(() => engine.returnToIdle(), 1800);
  };

  const dismissActive = async (id: string, action: "dismissed" | "completed") => {
    try {
      await invokeCommand("record_reminder_action", { id, action });
    } catch {
      /* demo mode */
    }
    engineRef.current!.dismissReminder();
    setActiveReminder(null);
    if (action === "completed") {
      // She beams with pride, then leaves with her exit behavior.
      flashExpression("proud", 1600);
      exitAfterBeat(1300);
      return;
    }
    maybeHideAfterReminder();
  };

  const snoozeActive = async (id: string, minutes: 10 | 30 | 60) => {
    try {
      await invokeCommand("snooze_reminder", { id, minutes });
    } catch {
      /* demo mode */
    }
    engineRef.current!.snoozeReminder();
    setActiveReminder(null);
    // She gets drowsy, then leaves with her exit behavior.
    flashExpression("sleepy", 1400);
    exitAfterBeat(1200);
  };

  const pauseAll = async (minutes: 30 | 60 | null) => {
    try {
      await invokeCommand("pause_all", { minutes });
    } catch {
      /* demo mode */
    }
    engineRef.current!.pause();
    setActiveReminder(null);
    setPaused(true);
    maybeHideAfterReminder();
  };

  const resumeAll = async () => {
    try {
      await invokeCommand("resume_all");
    } catch {
      /* demo mode */
    }
    engineRef.current!.resume();
    setPaused(false);
  };

  const testReminder = async () => {
    // The overlay must be visible: leave the panel first (this was the bug —
    // the reminder fired underneath the open settings panel).
    // In "system notification" mode there is no overlay: the backend sends
    // an OS notification instead, so Nila stays in the tray. Same for
    // "hidden" visibility.
    const behavior = settingsRef.current.reminder_behavior;
    const hidden = settingsRef.current.character_visibility === "hidden";
    if (behavior !== "system" && !hidden) {
      manualOpenRef.current = true;
      setView("companion");
      void presentCompanion("idle");
    }
    if (!isTauri()) {
      if (behavior === "system" || hidden) return;
      const r: DueReminder = {
        id: "demo",
        title: "Vellam",
        message: "Vellam kudicho? (demo)",
        kind: "water",
      };
      engineRef.current!.beginReminder("water");
      flashExpression("surprised", 1200);
      chimeForReminder();
      setActiveReminder(r);
      return;
    }
    try {
      await invokeCommand("test_reminder");
    } catch {
      /* ignore */
    }
  };

  const updateReminder = async (id: string, input: ReminderInput) => {
    const prev = reminders.find((x) => x.id === id);
    setReminders((list) =>
      list.map((x) =>
        x.id === id
          ? {
              ...x,
              title: input.title,
              message: input.message,
              kind: input.kind,
              schedule: input.schedule,
            }
          : x,
      ),
    );
    try {
      await invokeCommand("update_reminder", {
        id,
        input: {
          title: input.title,
          message: input.message,
          kind: input.kind,
          schedule: scheduleToJson(input.schedule),
          enabled: prev?.enabled ?? true,
        },
      });
    } catch {
      /* demo mode: keep optimistic state */
    }
  };

  const saveSettings = async (s: AppSettings) => {
    setSettings(s);
    const engine = engineRef.current!;
    engine.setSize(s.character_size);
    engine.setMotion(s.animation);
    engine.setIdleBehavior(s.idle_behavior);
    try {
      await invokeCommand("update_settings", { settings: settingsToRecord(s) });
    } catch {
      /* demo mode */
    }
    // Settings apply immediately and stay open; closing the panel returns
    // Nila to the tray. Presence changes re-seat her right away when she
    // is on screen (no entrance animation, just the new spot/tilt).
    if (view === "companion" && !activeReminder) {
      void (async () => {
        if (!isTauri()) return;
        const visible = await getCurrentWindow().isVisible().catch(() => false);
        if (visible) await seatCompanion();
      })();
    }
  };

  // Tray menu events from the backend.
  // Intercept the OS close button (native decorations): closing the
  // settings window sends Nila back to the tray instead of quitting.
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        unlisten = await getCurrentWindow().onCloseRequested((e) => {
          e.preventDefault();
          hideToTray();
        });
      } catch {
        /* ignore */
      }
    })();
    return () => {
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let offShow: (() => void) | null = null;
    let offPause: (() => void) | null = null;
    let offHidden: (() => void) | null = null;
    (async () => {
      offShow = await listenEvent<string>("TRAY_SHOW", (mode) => {
        manualOpenRef.current = true;
        if (mode === "settings") {
          void refreshSettings();
          setView("settings");
          // Same panel treatment as the gear button: resizable, not
          // always-on-top, sized before showing so the window never
          // gets stuck at the small companion size.
          void (async () => {
            await setPanelChrome(true);
            await resizeWindow(PANEL_W, PANEL_H);
            await showAppWindow();
          })();
        } else {
          setView("companion");
          void presentCompanion("idle");
        }
      });
      offPause = await listenEvent("TRAY_PAUSE", () => {
        if (pausedRef.current) void resumeAll();
        else void pauseAll(60);
      });
      offHidden = await listenEvent("TRAY_HIDDEN", () => {
        manualOpenRef.current = false;
        setActiveReminder(null);
        setView("companion");
      });
    })();
    return () => {
      offShow?.();
      offPause?.();
      offHidden?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleReminder = async (id: string, enabled: boolean) => {
    const r = reminders.find((x) => x.id === id);
    if (!r) return;
    setReminders((prev) => prev.map((x) => (x.id === id ? { ...x, enabled } : x)));
    try {
      await invokeCommand("update_reminder", {
        id,
        input: {
          title: r.title,
          message: r.message,
          kind: r.kind,
          schedule: scheduleToJson(r.schedule),
          enabled,
        },
      });
    } catch {
      /* demo mode: keep optimistic state */
    }
  };

  const deleteReminder = async (id: string) => {
    setReminders((prev) => prev.filter((x) => x.id !== id));
    try {
      await invokeCommand("delete_reminder", { id });
    } catch {
      /* demo mode */
    }
  };

  const createReminder = async (input: {
    title: string;
    message: string;
    kind: ReminderKind;
    schedule: Schedule;
  }) => {
    try {
      const dto = await invokeCommand<ReminderDto>("create_reminder", {
        input: { ...input, schedule: scheduleToJson(input.schedule), enabled: true },
      });
      setReminders((prev) => [...prev, toReminder(dto)]);
    } catch {
      /* demo mode */
    }
  };

  const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;

  return (
    <div
      className="companion"
      onClick={handleCompanionClick}
      onDoubleClick={() => engineRef.current!.playAnimation("happy-bounce")}
      role="button"
      aria-label="Nila"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") handleCompanionClick();
        if (e.key === "Escape") hideToTray();
      }}
    >
      {snap.visible && (
        <div
          className={`nila-stage${stageFading ? " stage-hidden" : ""}${enterAnim ? ` ${enterAnim}` : ""}`}
          style={enterAnim ? { animationDuration: `${settings.entrance_ms}ms` } : undefined}
        >
          {activeReminder ? (
            <div className={`reminder-stage side-${bubbleSide}`}>
              {(bubbleSide === "left" || bubbleSide === "above") && (
                <div className="reminder-bubble">
                  <ReminderOverlay
                    inLayout
                    reminder={activeReminder}
                    onDone={dismissActive}
                    onSnooze={snoozeActive}
                    onPause={() => void pauseAll(30)}
                  />
                </div>
              )}
              <div className="reminder-char" style={{ transform: charTransform }}>
                <div className="char-drag" onMouseDown={startDrag}>
                  <NilaCharacter
                    state={snap.state}
                    animation={snap.animation}
                    size={snap.size}
                    dark={dark}
                    expression={snap.expression}
                    groundShadow={showGroundShadow}
                  />
                </div>
              </div>
              {(bubbleSide === "right" || bubbleSide === "below") && (
                <div className="reminder-bubble">
                  <ReminderOverlay
                    inLayout
                    reminder={activeReminder}
                    onDone={dismissActive}
                    onSnooze={snoozeActive}
                    onPause={() => void pauseAll(30)}
                  />
                </div>
              )}
            </div>
          ) : (
            <div className="idle-char" style={{ transform: charTransform }}>
              <div className="char-drag" onMouseDown={startDrag}>
                <NilaCharacter
                  state={snap.state}
                  animation={snap.animation}
                  size={snap.size}
                  dark={dark}
                  expression={snap.expression}
                  groundShadow={showGroundShadow}
                />
              </div>
            </div>
          )}
        </div>
      )}
      {greeted && !activeReminder && snap.state === "waving" && (
        <div className="bubble" role="status">
          {ONBOARDING.hello}
        </div>
      )}
      {view === "companion" && !activeReminder && (
        <button
          type="button"
          className="gear-btn"
          aria-label={getStrings(settings.language).window.title}
          onClick={(e) => {
            e.stopPropagation();
            void openPanel("settings");
          }}
        >
          <IconGeneral />
        </button>
      )}
      {view !== "companion" && (
        <div className="panel-wrap">
          <SettingsPanel
            settings={settings}
            paused={paused}
            reminders={reminders}
            nativeTitlebar={decorated}
            onSave={(s) => void saveSettings(s)}
            onPause={(m) => void pauseAll(m)}
            onResume={() => void resumeAll()}
            onTest={() => void testReminder()}
            onClose={hideToTray}
            onMinimize={minimizeWindow}
            onDataChanged={() => void reloadAfterImport()}
            onFlash={(name) => flashExpression(name, 1500)}
            onToggleReminder={(id, en) => void toggleReminder(id, en)}
            onDeleteReminder={(id) => void deleteReminder(id)}
            onCreateReminder={(input) => void createReminder(input)}
            onUpdateReminder={(id, input) => void updateReminder(id, input)}
          />
        </div>
      )}
    </div>
  );
}
