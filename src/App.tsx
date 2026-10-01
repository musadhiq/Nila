import { useCallback, useEffect, useRef, useState } from "react";
import {
  availableMonitors,
  currentMonitor,
  getCurrentWindow,
  LogicalSize,
  PhysicalPosition,
  primaryMonitor,
  type Monitor,
} from "@tauri-apps/api/window";
import { CharacterEngine, CharacterLab, NilaCharacter, peekSequenceForPreset, useFramePlayback } from "./character";
import type { CharacterSnapshot } from "./character";
import type { ExpressionName } from "./character/expressions";
import {
  backgroundPreloadAll,
  frameUrl,
  preloadForFirstAppearance,
} from "./character/motionAssets";
import { getStrings } from "./lib/i18n";
import type { AppSettings, Reminder, ReminderKind, Schedule } from "./lib/types";
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
import type { MonitorRect } from "./lib/windowPlacement";
import type { DueReminder } from "./components/ReminderOverlay";
import { NotificationDock } from "./dock/NotificationDock";
import { useNotificationDock } from "./dock/useNotificationDock";
import { NotificationPosition, dockWindowOrigin } from "./dock/positions";
import { isDockOnScreen } from "./dock/dockMachine";
import { SettingsPanel } from "./components/SettingsPanel";
import type { ReminderInput } from "./components/settings/ReminderEditor";

type View = "companion" | "settings";

function isPausedSettings(s: AppSettings): boolean {
  if (!s.paused_until) return false;
  const t = Date.parse(s.paused_until);
  return Number.isFinite(t) && t > Date.now();
}

/**
 * Nila companion window: transparent window hosting either the settings
 * panel or the top-center notification dock. Listens for REMINDER_DUE
 * from the Rust scheduler; settings live in the tray menu.
 */
export default function App() {
  const engineRef = useRef<CharacterEngine | null>(null);
  if (!engineRef.current) engineRef.current = new CharacterEngine();
  const [snap, setSnap] = useState<CharacterSnapshot>(() => engineRef.current!.snapshot());
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [view, setView] = useState<View>("companion");
  const [paused, setPaused] = useState(false);
  /** True while the settings panel uses native OS window decorations
   *  (titlebar + resize handles). The custom titlebar hides then. */
  const [decorated, setDecorated] = useState(false);
  // Dev-only Character Lab (spec 24).
  const [labOpen, setLabOpen] = useState(false);
  // Resolved motion-frame URL for the engine's current frame (with the
  // fallback hierarchy applied); null falls back to the legacy image.
  const frameSrc = snap.frame ? frameUrl(snap.frame.key) : null;
  // Dev-only character debug overlay (?nila-debug or localStorage).
  const [nilaDebug] = useState(
    () =>
      typeof window !== "undefined" &&
      (window.location.search.includes("nila-debug") ||
        window.localStorage.getItem("nila.debug") === "1"),
  );
  // Frame-sequence playback: per-frame timers + idle blink injection.
  useFramePlayback(engineRef.current, snap);
  /**
   * V1 notification surface: the top-center dock. The hook owns the
   * dock state machine (hidden -> entering -> expanding -> visible ->
   * acknowledging -> collapsing), the notification queue, and Nila's
   * gesture choreography through the character engine.
   */
  const prefersReducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  const dock = useNotificationDock({
    playSequence: (name) => engineRef.current!.playSequence(name),
    reducedMotion: settings.animation !== "full" || prefersReducedMotion,
  });
  // Fresh dock api inside long-lived event handlers (the REMINDER_DUE
  // listener is registered once).
  const dockRef = useRef(dock);
  dockRef.current = dock;
  // The dock machine drives the window: when the first notification
  // starts entering, seat the window top-center and show it; when the
  // last one finishes collapsing, hide back to the tray. The settings
  // panel owns the window while it is open, so the dock never fights it.
  const dockPhaseRef = useRef(dock.phase);
  useEffect(() => {
    const prev = dockPhaseRef.current;
    dockPhaseRef.current = dock.phase;
    if (prev === dock.phase || view !== "companion" || !isTauri()) return;
    if (prev === "hidden" && isDockOnScreen(dock.phase)) {
      void presentDockWindow();
    } else if (dock.phase === "hidden" && isDockOnScreen(prev)) {
      void hideDockWindow();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dock.phase, view]);
  // Window lifecycle: Nila lives in the menu-bar tray. The floating window
  // only appears when a reminder is due, or when opened from the tray.
  // `manualOpen` tracks a user-opened window so reminder dismissal doesn't
  // hide a window the user asked to see.
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  // Fresh settings inside event handlers (the REMINDER_DUE listener is
  // registered once but needs the current sound/motion choices).
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const viewRef = useRef(view);
  viewRef.current = view;

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
        // Companion/dock: frameless, always-on-top, no size locks — the
        // dock fits the window to its card when it presents.
        await win.setDecorations(false);
        await win.setMinSize(null);
        await win.setMaxSize(null);
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

  /** Send Nila back to the tray (used when closing panels). */
  const hideToTray = () => {
    setView("companion");
    const phase = dockRef.current.phase;
    void (async () => {
      await setPanelChrome(false);
      if (phase === "hidden") {
        // Tray-first: when idle the dock is hidden, so closing the panel
        // hides the window.
        await hideDockWindow();
      } else if (isDockOnScreen(phase)) {
        // A notification was on screen when the panel opened: give the
        // window back to the dock (it never stopped being live).
        await presentDockWindow();
      }
    })();
  };

  /**
   * Dock window geometry. The transparent window is fitted tightly
   * around the measured dock card (plus breathing room for Nila's
   * shadow) so the invisible window area never blocks more of the
   * desktop than necessary. The card reports its layout size via
   * onMeasure; before the first report we use a sane estimate and
   * correct on arrival.
   */
  /** Top clearance: the dock hangs just below the system top bar. */
  const DOCK_SAFE_MARGIN = 34;
  /** Window padding around the card: shadow spread + animation overshoot. */
  const DOCK_PAD_X = 56;
  const DOCK_PAD_Y = 64;
  /** Pre-measure estimate (typical card) so the first present is sane. */
  const dockCardSize = useRef({ w: 340, h: 120 });

  /** Size + top-center the dock window around the measured card. */
  const fitDockWindow = async () => {
    const win = getCurrentWindow();
    // Clear any locks left by the settings panel (min 720x480) or the
    // old sprite path — the dock owns its size while it is on screen.
    await win.setMinSize(null);
    await win.setMaxSize(null);
    await win.setDecorations(false);
    await win.setAlwaysOnTop(true);
    const { w, h } = dockCardSize.current;
    const winW = Math.ceil(w + DOCK_PAD_X);
    const winH = Math.ceil(h + DOCK_PAD_Y);
    await win.setSize(new LogicalSize(winW, winH));
    const info = await monitorInfo();
    if (info.rects.length === 0) return;
    let mi = info.primary;
    const cur = await currentMonitor().catch(() => null);
    if (cur) {
      const i = info.rects.findIndex(
        (r) => r.x === cur.position.x && r.y === cur.position.y,
      );
      if (i >= 0) mi = i;
    }
    const mon = info.rects[mi];
    const scale = info.scales[mi] ?? 1;
    const o = dockWindowOrigin(
      NotificationPosition.TOP_CENTER,
      mon,
      Math.round(winW * scale),
      Math.round(winH * scale),
      Math.round(DOCK_SAFE_MARGIN * scale),
    );
    await win.setPosition(new PhysicalPosition(o.x, o.y));
  };

  /** The card measured itself: keep the window fitted while on screen. */
  const handleDockMeasure = useCallback(
    (w: number, h: number) => {
      const prev = dockCardSize.current;
      if (Math.abs(prev.w - w) < 2 && Math.abs(prev.h - h) < 2) return;
      dockCardSize.current = { w: Math.ceil(w), h: Math.ceil(h) };
      if (isTauri() && isDockOnScreen(dockRef.current.phase)) {
        void fitDockWindow().catch(() => {});
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const presentDockWindow = async () => {
    if (!isTauri()) return;
    try {
      await fitDockWindow();
      await getCurrentWindow().show();
      // Deliberately no setFocus(): a notification island must not steal
      // keyboard focus from the user's work.
    } catch {
      try {
        await getCurrentWindow().show();
      } catch {
        /* ignore */
      }
    }
  };

  /** Hide the dock window (tray-first: she lives in the tray when idle). */
  const hideDockWindow = async () => {
    if (!isTauri()) return;
    try {
      await getCurrentWindow().hide();
    } catch {
      /* ignore */
    }
  };

  /**
   * Reveal the companion using the configured presence (spec 47/54):
   * position, entrance behavior, orientation, tilt.
   */
  // Engine -> React state.
  useEffect(() => {
    const off = engineRef.current!.onChange(setSnap);
    return off;
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
        setSettings(merged);
        setPaused(isPausedSettings(merged));
        engineRef.current!.setSize(merged.character_size);
        engineRef.current!.setMotion(merged.animation);
        // Motion assets: preload the first-appearance set (idle loop +
        // this position's peek frames) before she can appear, then the
        // rest in the background.
        if (merged.animation === "full") {
          const peek = peekSequenceForPreset(
            merged.position_preset,
            merged.top_hang,
          );
          void preloadForFirstAppearance(
            peek ? [peek.enter, peek.exit] : [],
          ).then(() => backgroundPreloadAll());
        }
        // V1 is tray-first: Nila appears via the notification dock when a
        // reminder is due (or when opened from the tray). There is no
        // floating character to keep on screen, so "always visible" does
        // not auto-present anything here.
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
        const hidden = settingsRef.current.character_visibility === "hidden";
        // "Hidden" mode: Nila never appears on screen. The scheduler
        // delivers the reminder as an OS notification instead.
        if (hidden) return;
        // V1: the top-center notification dock is the only on-screen
        // surface. The dock machine queues overlapping reminders and
        // choreographs Nila's gestures; the phase effect seats the
        // window top-center and shows it.
        setView("companion");
        chimeForReminder();
        dockRef.current.notify({ id: r.id, title: r.title, message: r.message, kind: r.kind });
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
      // Also reload reminders so the list is never stale when the panel opens.
      const dtos = await invokeCommand<ReminderDto[]>("list_reminders");
      setReminders(dtos.map(toReminder));
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

  const minimizeWindow = () => {
    if (!isTauri()) return;
    void getCurrentWindow().minimize().catch(() => {});
  };

  /**
   * Exit sequence (spec 16): the bubble fades first, then Nila reacts,
   * then she leaves with her exit behavior. Never unmounts instantly.
   */
  /**
   * Dock V1: Done/Dismiss. Records the action (unless this is a local
   * greeting card with no backend reminder), then the dock machine plays
   * Nila's acknowledgment gesture and collapses. The phase effect hides
   * the window when the last notification finishes.
   */
  const dismissActive = async (id: string, action: "dismissed" | "completed") => {
    if (!id.startsWith("greeting-")) {
      try {
        await invokeCommand("record_reminder_action", { id, action });
      } catch {
        /* demo mode */
      }
    }
    dock.dismiss(action);
  };

  /** Dock V1: Snooze. Reschedules (unless a greeting card), then ack. */
  const snoozeActive = async (id: string, minutes: 10 | 30 | 60) => {
    if (!id.startsWith("greeting-")) {
      try {
        await invokeCommand("snooze_reminder", { id, minutes });
      } catch {
        /* demo mode */
      }
      dock.dismiss("snoozed");
    } else {
      // Greetings have no backend reminder to reschedule: just acknowledge.
      dock.dismiss("dismissed");
    }
  };

  const pauseAll = async (minutes: 30 | 60 | null) => {
    try {
      await invokeCommand("pause_all", { minutes });
    } catch {
      /* demo mode */
    }
    engineRef.current!.pause();
    dock.forceHide();
    if (view === "companion") void hideDockWindow();
    setPaused(true);
    // Keep the settings state in sync: pause_all writes paused_until to the
    // Rust store, but a later saveSettings() with a stale settings object
    // would overwrite it with "". Refresh from Rust so the state matches.
    try {
      const raw = await invokeCommand<Record<string, string>>("get_settings");
      const merged = mergeSettings(raw);
      setSettings(merged);
      setPaused(isPausedSettings(merged));
    } catch {
      /* demo mode */
    }
  };

  const resumeAll = async () => {
    try {
      await invokeCommand("resume_all");
    } catch {
      /* demo mode */
    }
    engineRef.current!.resume();
    setPaused(false);
    // Same sync as pauseAll: resume_all clears paused_until in Rust.
    try {
      const raw = await invokeCommand<Record<string, string>>("get_settings");
      const merged = mergeSettings(raw);
      setSettings(merged);
      setPaused(isPausedSettings(merged));
    } catch {
      /* demo mode */
    }
  };

  const testReminder = async () => {
    // The dock must be visible: leave the panel first (this was the bug —
    // the reminder fired underneath the open settings panel).
    // In "hidden" visibility there is no dock: Nila stays in the tray.
    const hidden = settingsRef.current.character_visibility === "hidden";
    if (!isTauri()) {
      if (hidden) return;
      setView("companion");
      chimeForReminder();
      dock.notify({
        id: "demo",
        title: "Vellam",
        message: "Vellam kudicho? (demo)",
        kind: "water",
      });
      return;
    }
    try {
      await invokeCommand("test_reminder");
    } catch {
      /* ignore */
    }
  };

  /**
   * Development-only dock preview (from the Character settings page).
   * Closes the settings panel first — the dock owns the window — then
   * feeds preview notification(s) through the real dock machine, so
   * animations, long text, dismissal, snooze, and queueing are all
   * exercised exactly as a real reminder would.
   */
  const previewDock = async (kind: "short" | "long" | "queue") => {
    hideToTray();
    // Let the panel close before the dock takes the window.
    await new Promise((r) => window.setTimeout(r, 120));
    const stamp = Date.now();
    if (kind === "short") {
      dockRef.current.notify({
        id: `preview-${stamp}`,
        title: "Vellam",
        message: "Vellam kudicho? (preview)",
        kind: "water",
      });
      return;
    }
    if (kind === "long") {
      dockRef.current.notify({
        id: `preview-long-${stamp}`,
        title: "Time for a short break",
        message:
          "Time for a short break. Kurachu neram break eduthu onnu stretch cheyyam — stand up, roll your shoulders, look away from the screen for a minute, and drink some water before you dive back in.",
        kind: "break",
      });
      return;
    }
    // Queue: three notifications back-to-back; the dock shows them one
    // at a time in FIFO order.
    const msgs: Array<[string, string, string]> = [
      ["Vellam", "Vellam kudicho? Onnu kudichittu vaa.", "water"],
      ["Break", "Kurachu neram break eduthu onnu stretch cheyyam.", "break"],
      ["Food", "Chor kazhicho? Time ayi!", "food"],
    ];
    msgs.forEach(([title, message, k], i) => {
      dockRef.current.notify({
        id: `preview-q-${stamp}-${i}`,
        title,
        message,
        kind: k,
      });
    });
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
    // Frame motion (re)enabled or the presence spot changed: warm the
    // asset cache so her next appearance doesn't stall on image loads.
    if (s.animation === "full") {
      const peek = peekSequenceForPreset(s.position_preset, s.top_hang);
      void preloadForFirstAppearance(peek ? [peek.enter, peek.exit] : []).then(
        () => backgroundPreloadAll(),
      );
    }
    try {
      await invokeCommand("update_settings", { settings: settingsToRecord(s) });
    } catch {
      /* demo mode */
    }
    // Closing the panel returns Nila to the tray (tray-first V1).
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
        if (mode === "settings") {
          void refreshSettings();
          setView("settings");
          // Resizable panel with native chrome, sized before showing so
          // the window never gets stuck at a small size.
          void (async () => {
            await setPanelChrome(true);
            await resizeWindow(PANEL_W, PANEL_H);
            await showAppWindow();
          })();
        } else {
          // V1: "Show Nila" opens the dock with a greeting card (tray-first:
          // she lives in the tray when idle; there is no floating character).
          setView("companion");
          const s = getStrings(settingsRef.current.language);
          dockRef.current.notify({
            id: `greeting-${Date.now()}`,
            title: "Nila",
            message: s.dock.greeting,
            kind: "greeting",
          });
        }
      });
      offPause = await listenEvent("TRAY_PAUSE", () => {
        if (pausedRef.current) void resumeAll();
        else void pauseAll(60);
      });
      offHidden = await listenEvent("TRAY_HIDDEN", () => {
        dockRef.current.forceHide();
        if (viewRef.current === "companion") void hideDockWindow();
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
      onKeyDown={(e) => {
        // Escape anywhere outside the dock card sends her back to the tray.
        if (e.key === "Escape") hideToTray();
      }}
    >
      {view === "companion" && dock.phase !== "hidden" && (
        <NotificationDock
          phase={dock.phase}
          reminder={dock.current}
          queueCount={dock.queueLength}
          reducedMotion={settings.animation !== "full" || prefersReducedMotion}
          nila={
            <NilaCharacter
              state={snap.state}
              animation={snap.animation}
              size="small"
              dark={dark}
              expression={snap.expression}
              frame={snap.frame}
              frameSrc={frameSrc}
              shadow="soft"
            />
          }
          onDone={dismissActive}
          onSnooze={snoozeActive}
          onInteract={dock.interact}
          onDisengage={dock.disengage}
          onKeyDismiss={(id) => void dismissActive(id, "dismissed")}
          onMeasure={handleDockMeasure}
        />
      )}
      {import.meta.env.DEV && nilaDebug && view === "companion" && (
        <button
          type="button"
          className="lab-btn"
          onClick={(e) => {
            e.stopPropagation();
            setLabOpen(true);
          }}
        >
          Lab
        </button>
      )}
      {import.meta.env.DEV && nilaDebug && labOpen && (
        <CharacterLab onClose={() => setLabOpen(false)} />
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
            onPreviewDock={(kind) => void previewDock(kind)}
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
