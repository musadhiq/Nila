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
import { ONBOARDING } from "./lib/strings";
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
import {
  glidePosition,
  homePosition,
  isOnAnyMonitor,
  loadSavedPosition,
  saveWindowPosition,
  trayStartPosition,
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
      await win.setResizable(panel);
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
   * Nila's home position: where she was last left (if still on a monitor),
   * else bottom-right of the primary monitor. Physical pixels.
   */
  const resolveHomePosition = async (): Promise<Xy | null> => {
    try {
      const win = getCurrentWindow();
      const scale = await win.scaleFactor();
      const mons = await availableMonitors().catch((): Monitor[] => []);
      const rects = mons.map(toMonitorRect);
      const primary = await primaryMonitor().catch(() => null);
      const base = primary ? toMonitorRect(primary) : rects[0];
      if (!base) return null;
      const saved = loadSavedPosition();
      if (saved && isOnAnyMonitor(saved, rects.length ? rects : [base])) {
        return saved;
      }
      return homePosition(
        base,
        Math.round(COMPANION_W * scale),
        Math.round(COMPANION_H * scale),
      );
    } catch {
      return null;
    }
  };

  /** Place the (still hidden) window at home before it first appears. */
  const restoreHomePosition = async () => {
    if (!isTauri()) return;
    const home = await resolveHomePosition();
    if (!home) return;
    try {
      await getCurrentWindow().setPosition(new PhysicalPosition(home.x, home.y));
    } catch {
      /* leave the OS default */
    }
  };

  /**
   * Reveal the companion: resize, then glide in from the tray (top-right)
   * to Nila's home position. Reduced/off motion skips the glide.
   */
  const revealCompanion = async () => {
    if (!isTauri()) return;
    const win = getCurrentWindow();
    try {
      await setPanelChrome(false);
      await win.setSize(new LogicalSize(COMPANION_W, COMPANION_H));
      const show = async () => {
        await win.show();
        await win.setFocus().catch(() => {});
      };
      const motion = settingsRef.current.animation;
      const monitor = await currentMonitor().catch(() => null);
      if (!monitor || motion !== "full") {
        await show();
        return;
      }
      const scale = await win.scaleFactor();
      const winW = Math.round(COMPANION_W * scale);
      const rect = toMonitorRect(monitor);
      const home = await resolveHomePosition();
      const target = home ?? (await win.outerPosition().catch(() => null)) ?? { x: rect.x, y: rect.y };
      const start = trayStartPosition(rect, winW);
      await win.setPosition(new PhysicalPosition(start.x, start.y));
      await show();
      await glidePosition(start, { x: target.x, y: target.y }, 700, (x, y) => {
        void win.setPosition(new PhysicalPosition(x, y)).catch(() => {});
      });
    } catch {
      try {
        await win.show();
      } catch {
        /* ignore */
      }
    }
  };

  /** Send Nila back to the tray (used when closing panels). */
  const hideToTray = () => {
    manualOpenRef.current = false;
    pendingReminderRef.current = null;
    setActiveReminder(null);
    setView("companion");
    void setPanelChrome(false);
    void resizeWindow(COMPANION_W, COMPANION_H);
    // "Always visible" keeps Nila on screen: closing settings just
    // returns to the companion instead of hiding to the tray.
    if (settingsRef.current.character_visibility === "always") {
      void revealCompanion();
    } else {
      void hideAppWindow();
    }
  };

  /** After a reminder is handled, hide again unless the user opened the window. */
  const maybeHideAfterReminder = () => {
    if (manualOpenRef.current) return;
    if (settingsRef.current.character_visibility === "always") return;
    void hideAppWindow();
  };

  /**
   * Let an expression beat play (proud/sleepy), then slip back into the
   * tray — unless the user opened the window themselves.
   */
  const hideAfterBeat = (ms: number) => {
    if (manualOpenRef.current) return;
    if (settingsRef.current.character_visibility === "always") return;
    if (pendingHideRef.current !== null) window.clearTimeout(pendingHideRef.current);
    pendingHideRef.current = window.setTimeout(() => {
      pendingHideRef.current = null;
      if (!manualOpenRef.current) void hideAppWindow();
    }, ms);
  };

  /** Drag the floating window by the character (Tauri only). */
  const startDrag = (e: React.MouseEvent) => {
    downPos.current = { x: e.clientX, y: e.clientY };
    if (!isTauri() || e.button !== 0) return;
    if (view !== "companion" || activeReminder) return;
    void getCurrentWindow().startDragging().catch(() => {});
  };

  // Engine -> React state.
  useEffect(() => {
    const off = engineRef.current!.onChange(setSnap);
    return off;
  }, []);

  // Remember Nila's home: after the user drags her somewhere, persist the
  // position (debounced) so she always returns to the same spot.
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
            void getCurrentWindow()
              .outerPosition()
              .then((p) => saveWindowPosition(p.x, p.y))
              .catch(() => {});
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
  }, []);

  // First-launch greeting.
  useEffect(() => {
    const t = window.setTimeout(() => {
      engineRef.current!.wave();
      setGreeted(true);
      window.setTimeout(() => engineRef.current!.returnToIdle(), 2500);
    }, 600);
    // The window starts hidden in the tray; put it at home before it
    // first appears so the fly-in always starts from the right place.
    void restoreHomePosition();
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
        setSettings(merged);
        setPaused(isPausedSettings(merged));
        engineRef.current!.setSize(merged.character_size);
        engineRef.current!.setMotion(merged.animation);
        // "Always visible": Nila stays on screen from launch.
        if (merged.character_visibility === "always") void revealCompanion();
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
          void revealCompanion();
          hideAfterBeat(30000);
          return;
        }
        setActiveReminder(r);
        // She gasps, then points at the reminder bubble.
        flashExpression("surprised", 800);
        exprTimers.current.push(
          window.setTimeout(() => engineRef.current!.showExpression("point"), 800),
          window.setTimeout(() => engineRef.current!.clearExpression(), 1800),
        );
        chimeForReminder();
        // A reminder is due: Nila appears, gliding in from the tray to
        // her home position. The overlay takes over the window.
        setView("companion");
        void revealCompanion();
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

  const openPanel = (v: View) => {
    manualOpenRef.current = true;
    if (v === "settings") void refreshSettings();
    setView(v);
    void setPanelChrome(true);
    void resizeWindow(PANEL_W, PANEL_H);
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
      // She beams with pride, then slips back into the tray.
      flashExpression("proud", 1600);
      hideAfterBeat(1300);
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
    // She gets drowsy, then slips back into the tray.
    flashExpression("sleepy", 1400);
    hideAfterBeat(1200);
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
      void revealCompanion();
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
    // Nila to the tray.
  };

  // Tray menu events from the backend.
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
          void resizeWindow(PANEL_W, PANEL_H);
          void showAppWindow();
        } else {
          setView("companion");
          void revealCompanion();
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
        <div className="char-drag" onMouseDown={startDrag}>
          <NilaCharacter
            state={snap.state}
            animation={snap.animation}
            size={snap.size}
            dark={dark}
            expression={snap.expression}
          />
        </div>
      )}
      {greeted && !activeReminder && snap.state === "waving" && (
        <div className="bubble" role="status">
          {ONBOARDING.hello}
        </div>
      )}
      {activeReminder && (
        <ReminderOverlay
          reminder={activeReminder}
          onDone={dismissActive}
          onSnooze={snoozeActive}
          onPause={() => void pauseAll(30)}
        />
      )}
      {view === "companion" && !activeReminder && (
        <button
          type="button"
          className="gear-btn"
          aria-label={getStrings(settings.language).window.title}
          onClick={(e) => {
            e.stopPropagation();
            openPanel("settings");
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
