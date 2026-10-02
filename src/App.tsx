import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  availableMonitors,
  currentMonitor,
  getCurrentWindow,
  LogicalSize,
  PhysicalPosition,
  primaryMonitor,
  type Monitor,
} from "@tauri-apps/api/window";
import { CharacterEngine } from "./character/engine";
import { peekSequenceForPreset } from "./character/motionManifest";
// CharacterLab is dev-only: lazy-load it so the character asset library
// (NilaCharacter's ~22 state PNGs) never rides the production bundle.
const CharacterLab = lazy(() =>
  import("./character/CharacterLab").then((m) => ({ default: m.CharacterLab })),
);
import type { ExpressionName } from "./character/expressions";
import {
  backgroundPreloadAll,
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
import { emitEvent, invokeCommand, isTauri, listenEvent } from "./lib/tauri";
import {
  MODEL_EVENTS,
  VOICE_EVENTS,
  voiceErrorLabel,
  type ModelsDownloadingPayload,
  type VoiceErrorCode,
  type VoiceErrorPayload,
  type VoiceFinalPayload,
  type VoicePartialPayload,
  type VoicePhase,
  type VoiceRepeatPayload,
} from "./lib/voice";
import {
  JEV_EVENTS,
  type JevError,
  type JevResultPayload,
  type JevUiActionPayload,
} from "./lib/jev";
import { VoiceCommandPipeline } from "./lib/voiceCommandPipeline";
import { playReminderChime } from "./lib/sound";
import type { MonitorRect } from "./lib/windowPlacement";
import type { DueReminder } from "./components/ReminderOverlay";
import { WakePill } from "./components/WakePill";
import { NotificationDock } from "./dock/NotificationDock";
import { DockNilaFigure } from "./dock/DockNila";
import { expressionSlotForContext } from "./dock/expressionSlots";
import { expressionUrl } from "./dock/expressions";
import { useNotificationDock } from "./dock/useNotificationDock";
import { NotificationPosition, dockWindowOrigin } from "./dock/positions";
import { isDockActionable, isDockOnScreen } from "./dock/dockMachine";
import { SettingsPanel } from "./components/SettingsPanel";
import type { PageId } from "./components/settings/SettingsLayout";
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
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [view, setView] = useState<View>("companion");
  const [paused, setPaused] = useState(false);
  /**
   * Wake-word state: true while Nila is in the LISTENING_FOR_COMMAND
   * visual window after the wake word was detected. The pill only
   * renders while the notification dock is hidden (the dock owns the
   * window while a reminder is on screen).
   */
  const [wakeListening, setWakeListening] = useState(false);
  /**
   * Voice-session state, driven by the Rust voice worker's events
   * (voice:started → voice:transcript_partial* → voice:transcript_final
   * → voice:processing → voice:ended). While active, the wake pill shows
   * live partials as subtext inside the pill, then a transcript bubble;
   * the pill stays on screen until voice:ended.
   * Partials are UI-only and never reach the future Jev layer — only the
   * finalized voice_command payload does.
   */
  const [voicePhase, setVoicePhase] = useState<VoicePhase>("idle");
  const [voiceText, setVoiceText] = useState("");
  const [voiceErrorCode, setVoiceErrorCode] = useState<VoiceErrorCode | null>(null);
  /**
   * Mirrors voicePhase for event handlers registered once. The voice
   * worker parks the wake listener mid-hold, whose 6s listen window may
   * still emit a stale nila://wake-idle — that must not hide an active
   * voice session.
   */
  const voiceActiveRef = useRef(false);
  /**
   * Conversation mode: after one wake word, Nila stays present and the
   * user can keep talking without repeating the wake phrase. Each answer
   * emits nila://conversation-turn, which the voice worker treats like a
   * wake event to start another VAD-bounded listening session. Set false
   * on goodbye, error, or explicit dismissal.
   */
  const conversationModeRef = useRef(false);
  /** True while a conversation turn is pending the previous session's
   * voice:ended — the backend rejects overlapping sessions, so the
   * re-arm must wait for the handoff. */
  const pendingRearmRef = useRef(false);
  /** Tracks whether the current voice session has ended (voice:ended
   * arrived). Set false on voice:started. */
  const sessionEndedRef = useRef(true);
  const CONVERSATION_REARM_DELAY_MS = 900;
  /**
   * Dismiss the conversation: end conversation mode, clear the response,
   * and hide the wake surface. Called by the Okay Nila button and ×.
   */
  const dismissConversation = useCallback(() => {
    conversationModeRef.current = false;
    pendingRearmRef.current = false;
    voiceActiveRef.current = false;
    setVoicePhase("idle");
    setVoiceText("");
    setVoiceErrorCode(null);
    setWakeListening(false);
  }, []);
  /** First-run setup flow: the panel opens on the welcome page with a
   *  finish button. Cleared once the user completes setup. */
  const [setupMode, setSetupMode] = useState(false);
  /** Bumped every time the panel opens so it mounts fresh on the
   *  right page (welcome for setup, general otherwise). */
  const [panelKey, setPanelKey] = useState(0);
  /** Tray "New Reminder" lands the panel on the reminders page ... */
  const [panelPage, setPanelPage] = useState<PageId | null>(null);
  /** ... and opens the reminder editor immediately. */
  const [panelAutoNew, setPanelAutoNew] = useState(false);
  /** Voice-prefilled reminder title ("remind me to drink water"). */
  const [panelPrefillTitle, setPanelPrefillTitle] = useState<string | null>(null);
  /** True while the settings panel uses native OS window decorations
   *  (titlebar + resize handles). The custom titlebar hides then. */
  const [decorated, setDecorated] = useState(false);
  // Dev-only Character Lab (spec 24).
  const [labOpen, setLabOpen] = useState(false);
  // Dev-only character debug overlay (?nila-debug or localStorage).
  const [nilaDebug] = useState(
    () =>
      typeof window !== "undefined" &&
      (window.location.search.includes("nila-debug") ||
        window.localStorage.getItem("nila.debug") === "1"),
  );
  // Frame-sequence playback (idle loop + blink injection) lives in
  // useFramePlayback and only runs while a frame renderer is mounted.
  // NilaCharacter mounts solely in the dev-only Character Lab, so in
  // production no per-frame timers or engine subscriptions exist: the
  // app sits fully idle in the tray until a reminder fires.
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
  // Nila's current expression slot: an acknowledgement reaction
  // overrides the kind expression while it plays. Resolved once here so
  // the portrait and its blink frames always agree.
  const nilaSlot =
    dock.reaction ??
    (dock.current
      ? expressionSlotForContext(
          dock.current.id.startsWith("greeting-")
            ? { type: "greeting" }
            : { type: "kind", kind: dock.current.kind },
        )
      : "greeting");
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
  // The wake-word pill drives the window too, but only while the dock is
  // hidden: the notification dock owns the window whenever a reminder is
  // on screen, and the settings panel owns it while open. When the wake
  // listen window ends, the window returns to the tray — unless the dock
  // is on screen (it never stopped being live).
  useEffect(() => {
    if (view !== "companion" || !isTauri()) return;
    const voiceActive = voicePhase !== "idle";
    if (wakeListening || voiceActive) {
      if (dockRef.current.phase === "hidden") void presentWakeWindow();
    } else if (dockRef.current.phase === "hidden") {
      void hideDockWindow();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wakeListening, voicePhase, view]);
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
   * Present the window for the wake-word listening pill: a small
   * top-center window, same seating as the dock, shown without stealing
   * focus. Deliberately separate from fitDockWindow — the pill has a
   * fixed, known size, so no measurement round-trip is needed.
   */
  const presentWakeWindow = async () => {
    if (!isTauri()) return;
    try {
      const win = getCurrentWindow();
      // Clear any locks left by the settings panel — the pill owns its
      // size while it is on screen.
      await win.setMinSize(null);
      await win.setMaxSize(null);
      await win.setDecorations(false);
      await win.setAlwaysOnTop(true);
      // Pill (~200x54) + transcript bubble + breathing room for the
      // entrance animation and the soft shadow. Fixed: no measurement
      // needed. Sized for the bubble's ~3 wrapped lines of transcript.
      const winW = 360;
      const winH = 200;
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
      await win.show();
      // Deliberately no setFocus(): waking must not steal keyboard focus
      // from the user's work.
    } catch {
      /* best-effort: the pill simply won't be visible */
    }
  };

  /**
   * Reveal the companion using the configured presence (spec 47/54):
   * position, entrance behavior, orientation, tilt.
   *
   * NOTE: the engine is driven imperatively (showExpression / setMotion /
   * pause / resume); there is deliberately no onChange subscription here.
   * Subscribing the App root to engine ticks re-rendered the whole tree
   * every animation frame even while idle in the tray, so playback now
   * only runs inside a mounted frame renderer (dev-only Character Lab).
   */

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
        // First run: open the setup flow instead of staying hidden.
        if (isTauri() && !merged.setup_complete) {
          openPanel("setup");
        }
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
    // React 18 StrictMode (tauri dev) runs this effect twice: setup,
    // cleanup, setup. The await below resolves after the first cleanup,
    // so the cleanup alone cannot undo the registration — the flag
    // catches the late arrival and unregisters it immediately.
    let cancelled = false;
    (async () => {
      const off = await listenEvent<unknown>("REMINDER_DUE", (payload) => {
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
      if (cancelled) {
        off();
        return;
      }
      unlisten = off;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  /**
   * Wake-word + voice-session events from the Rust workers. On
   * `nila://wake-detected` Nila wakes visually: the listening pill
   * renders and the window-ownership effect below seats the window
   * top-center without stealing focus. On `nila://wake-idle` (or the
   * listen window ending) she returns to the tray — unless a voice
   * session is active, which owns the surface until `voice:ended`.
   * "Hidden" mode keeps her off-screen for wake words too, like
   * reminders.
   */
  useEffect(() => {
    const unlistens: (() => void)[] = [];
    // Same StrictMode double-effect guard as the REMINDER_DUE listener.
    let cancelled = false;
    const setVoice = (
      phase: VoicePhase,
      text = "",
      code: VoiceErrorCode | null = null,
    ) => {
      voiceActiveRef.current = phase !== "idle";
      setVoicePhase(phase);
      setVoiceText(text);
      setVoiceErrorCode(code);
    };
    /**
     * Start a follow-up listening turn without the wake phrase. The small
     * delay keeps the re-arm clear of the backend's wake debounce.
     */
    const rearmConversation = () => {
      if (!conversationModeRef.current) return;
      pendingRearmRef.current = false;
      window.setTimeout(() => {
        if (conversationModeRef.current) {
          emitEvent("nila://conversation-turn");
        }
      }, CONVERSATION_REARM_DELAY_MS);
    };
    /**
     * Jev results → Nila's spoken response in the wake pill's bubble.
     * After one wake word, conversation mode keeps Nila present: the
     * response stays visible and the mic re-arms for a follow-up turn
     * without the wake phrase. Goodbye, UI actions (the panel takes
     * over), and errors end the conversation and dismiss as before.
     */
    const showJevResponse = (message: string, intent: string) => {
      if (!voiceActiveRef.current) return;
      const terminal =
        intent === "goodbye" ||
        intent === "error" ||
        intent === "new_reminder" ||
        intent === "show_reminders" ||
        intent === "open_settings";
      setVoice("processing", message);
      if (terminal) {
        conversationModeRef.current = false;
        pendingRearmRef.current = false;
        window.setTimeout(() => {
          setVoice("idle");
          setWakeListening(false);
        }, 5000);
        return;
      }
      // Conversation mode: stay visible. If the session already ended,
      // re-arm now; otherwise the voice:ended handler re-arms.
      conversationModeRef.current = true;
      if (sessionEndedRef.current) {
        rearmConversation();
      } else {
        pendingRearmRef.current = true;
      }
    };
    /**
     * VoiceCommandPipeline — the STT → Jev integration. It owns the
     * final-transcript handoff (validate → Jev service → response) and
     * the processing/executing/response lifecycle; the pill UI above is
     * untouched. Partials never reach it: only the
     * `voice:transcript_final` listener below calls into it.
     */
    const pipeline = new VoiceCommandPipeline({
      render: (phase, text) => {
        // The existing pill only distinguishes listening vs working —
        // pipeline processing/executing/response all keep its
        // "Working on it…" look.
        setVoice(phase === "idle" ? "idle" : "processing", text);
      },
      answer: showJevResponse,
      strings: () => getStrings(settingsRef.current.language),
    });
    (async () => {
      const hidden = () => settingsRef.current.character_visibility === "hidden";
      unlistens.push(
        await listenEvent("nila://wake-detected", () => {
          if (hidden()) return;
          setWakeListening(true);
        }),
      );
      unlistens.push(
        await listenEvent("nila://wake-idle", () => {
          if (voiceActiveRef.current) return;
          setWakeListening(false);
        }),
      );
      unlistens.push(
        await listenEvent(VOICE_EVENTS.started, () => {
          if (hidden()) return;
          sessionEndedRef.current = false;
          setVoice("listening");
        }),
      );
      unlistens.push(
        await listenEvent<VoicePartialPayload>(VOICE_EVENTS.partial, (p) => {
          // Live partials are display-only; Jev only ever sees the final.
          setVoice("recording", p.text);
        }),
      );
      unlistens.push(
        await listenEvent<VoiceFinalPayload>(VOICE_EVENTS.final, (p) => {
          // The pipeline validates the text and forwards it to the Jev
          // service. Partial transcripts never reach this listener, so
          // Jev only ever sees the final transcript.
          void pipeline.handleFinalTranscript(p.text);
        }),
      );
      unlistens.push(
        await listenEvent(VOICE_EVENTS.processing, () => {
          // Backend handoff beat; the frozen transcript stays visible.
          if (voiceActiveRef.current) setVoicePhase("processing");
        }),
      );
      unlistens.push(
        await listenEvent(VOICE_EVENTS.response, () => {
          // Reserved for the future Jev layer; not emitted in V1.
        }),
      );
      unlistens.push(
        await listenEvent<VoiceErrorPayload>(VOICE_EVENTS.error, (p) => {
          pipeline.handleVoiceError();
          setVoice("error", "", p.code);
        }),
      );
      unlistens.push(
        await listenEvent<VoiceRepeatPayload>(VOICE_EVENTS.repeat, () => {
          // Nila couldn't make out the words and asks the user to
          // repeat. The session stays alive — the pill keeps listening
          // and the prompt shows as subtext until the retry's live
          // partials replace it.
          if (!voiceActiveRef.current) return;
          setVoice(
            "listening",
            getStrings(settingsRef.current.language).voice.repeatPrompt,
          );
        }),
      );
      unlistens.push(
        await listenEvent(VOICE_EVENTS.ended, () => {
          sessionEndedRef.current = true;
          // A Jev command may still be running (voice:ended fires ~800ms
          // after the final transcript); its completion event owns the
          // surface until Nila's response has been shown.
          if (pipeline.isActive()) return;
          // Conversation mode: Nila's answer already requested a
          // follow-up turn — re-arm the mic instead of hiding.
          if (conversationModeRef.current && pendingRearmRef.current) {
            rearmConversation();
            return;
          }
          setVoice("idle");
          setWakeListening(false);
        }),
      );
      // Jev lifecycle → pipeline phases. The pipeline turns the
      // machine-readable payloads into Nila's EN/Manglish response and
      // drives the pill; stale events (no active command) are ignored.
      unlistens.push(
        await listenEvent(JEV_EVENTS.processing, () => {
          pipeline.handleJevProcessing();
        }),
      );
      unlistens.push(
        await listenEvent<{ intent: string }>(JEV_EVENTS.actionDetected, (p) => {
          pipeline.handleActionDetected(p.intent);
        }),
      );
      unlistens.push(
        await listenEvent<JevResultPayload>(JEV_EVENTS.result, (p) => {
          pipeline.handleResult(p);
        }),
      );
      unlistens.push(
        await listenEvent<JevError>(JEV_EVENTS.error, (p) => {
          pipeline.handleError(p);
        }),
      );
      unlistens.push(
        await listenEvent<JevUiActionPayload>(JEV_EVENTS.uiAction, (p) => {
          // Voice-triggered UI navigation. The opening UI is the
          // response — the pipeline returns to idle silently.
          pipeline.handleUiAction();
          switch (p.action) {
            case "open_new_reminder":
              openPanel("settings", {
                page: "reminders",
                autoNew: true,
                prefillTitle: p.prefill?.title || undefined,
              });
              break;
            case "open_reminders":
              openPanel("settings", { page: "reminders" });
              break;
            case "open_settings":
              openPanel("settings", { page: "general" });
              break;
            case "open_help":
              // The commands list takes over the surface; end any
              // conversation so a stale re-arm can't reopen the mic.
              conversationModeRef.current = false;
              pendingRearmRef.current = false;
              openPanel("settings", { page: "commands" });
              break;
          }
        }),
      );
      unlistens.push(
        await listenEvent<ModelsDownloadingPayload>(
          MODEL_EVENTS.downloading,
          (p) => {
            // Manual model download (from Settings): surface progress in
            // the active session's bubble if one happens to own the
            // surface right now. Silent otherwise.
            if (!voiceActiveRef.current) return;
            const pct =
              p.total_bytes > 0
                ? Math.round((p.downloaded_bytes / p.total_bytes) * 100)
                : 0;
            setVoiceText(
              `${getStrings(settingsRef.current.language).voice.modelsDownloading} ${pct}%`,
            );
          },
        ),
      );
      if (cancelled) {
        for (const off of unlistens) off();
        return;
      }
    })();
    return () => {
      cancelled = true;
      pipeline.dispose();
      for (const off of unlistens) off();
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

  /**
   * Open the settings panel. "setup" is the first-run flow: the panel
   * opens on the welcome page with a finish button; "settings" opens
   * normally on the general page. `opts.page` overrides the landing page
   * (tray "New Reminder" opens straight on reminders) and `opts.autoNew`
   * opens the reminder editor immediately.
   */
  const openPanel = (
    mode: "settings" | "setup",
    opts?: { page?: PageId; autoNew?: boolean; prefillTitle?: string },
  ) => {
    const setup = mode === "setup";
    void refreshSettings();
    setSetupMode(setup);
    setPanelPage(opts?.page ?? null);
    setPanelAutoNew(opts?.autoNew ?? false);
    setPanelPrefillTitle(opts?.prefillTitle ?? null);
    setView("settings");
    // Remount so the panel starts on the right page.
    setPanelKey((k) => k + 1);
    // Resizable panel with native chrome, sized before showing so
    // the window never gets stuck at a small size.
    void (async () => {
      await setPanelChrome(true);
      await resizeWindow(PANEL_W, PANEL_H);
      await showAppWindow();
    })();
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
    // The first action wins: ignore rapid double-actions (Done then
    // Snooze, double-click Done, or a click racing the 15s auto-hide).
    // The machine would ignore the second dismiss, but without this
    // guard the backend would still record both — e.g. a completion
    // plus a snooze on the same reminder, resurrecting a finished
    // one-time reminder.
    if (!isDockActionable(dockRef.current.phase)) return;
    if (!id.startsWith("greeting-")) {
      try {
        await invokeCommand("record_reminder_action", { id, action });
      } catch {
        /* demo mode */
      }
    }
    dock.dismiss(action);
  };

  /** Dock chat pill: snooze 10 minutes, then acknowledge. */
  const snoozeActive = async (id: string, minutes: 10 | 30 | 60) => {
    // Same first-action-wins guard as dismissActive.
    if (!isDockActionable(dockRef.current.phase)) return;
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
    // Same StrictMode double-effect guard as the REMINDER_DUE listener.
    let cancelled = false;
    (async () => {
      try {
        const off = await getCurrentWindow().onCloseRequested((e) => {
          e.preventDefault();
          hideToTray();
        });
        if (cancelled) {
          off();
          return;
        }
        unlisten = off;
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let offShow: (() => void) | null = null;
    let offPause: (() => void) | null = null;
    let offHidden: (() => void) | null = null;
    let offAutostart: (() => void) | null = null;
    // Same StrictMode double-effect guard as the REMINDER_DUE listener:
    // the first pass's registrations arrive after its cleanup ran.
    let cancelled = false;
    (async () => {
      const show = await listenEvent<string>("TRAY_SHOW", (mode) => {
        if (mode === "settings" || mode === "setup") {
          // Panel opens: normal settings, or the first-run setup flow.
          openPanel(mode);
        } else if (mode === "new-reminder") {
          // Tray "New Reminder": settings panel on the reminders page
          // with the editor already open.
          openPanel("settings", { page: "reminders", autoNew: true });
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
      if (cancelled) {
        show();
      } else {
        offShow = show;
      }
      const pause = await listenEvent("TRAY_PAUSE", () => {
        if (pausedRef.current) void resumeAll();
        else void pauseAll(60);
      });
      if (cancelled) {
        pause();
      } else {
        offPause = pause;
      }
      const hidden = await listenEvent("TRAY_HIDDEN", () => {
        dockRef.current.forceHide();
        if (viewRef.current === "companion") void hideDockWindow();
        setView("companion");
      });
      if (cancelled) {
        hidden();
      } else {
        offHidden = hidden;
      }
      // Tray "Launch on startup" checkbox: keep an open settings panel
      // in sync so a later save can't overwrite the new value.
      const autostartEvt = await listenEvent<boolean>("TRAY_AUTOSTART", (on) => {
        setSettings((prev) => ({ ...prev, start_at_login: on }));
      });
      if (cancelled) {
        autostartEvt();
      } else {
        offAutostart = autostartEvt;
      }
    })();
    return () => {
      cancelled = true;
      offShow?.();
      offPause?.();
      offHidden?.();
      offAutostart?.();
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
          reducedMotion={settings.animation !== "full" || prefersReducedMotion}
          nila={
            /* Centralized contextual expressions: the slot is resolved
             * by meaning (kind / greeting / rejection), never picked by
             * hand in the component. A dismissal reaction (sad, or
             * annoyed after a streak) overrides the kind expression while
             * it plays; done/snooze keep her face and answer with one
             * subtle blink instead. DockNilaFigure adds gentle life —
             * idle breathe, blink beats, expression crossfades, one-shot
             * reactions — without touching the card layout. */
            dock.current ? (
              <DockNilaFigure
                slot={nilaSlot}
                src={expressionUrl(nilaSlot)}
                alt={getStrings(settings.language).dock.nilaAlt}
                reaction={dock.reaction}
                blinkSignal={dock.blinkSignal}
                reducedMotion={settings.animation !== "full" || prefersReducedMotion}
              />
            ) : null
          }
          okayLabel={getStrings(settings.language).dock.okay}
          snoozeLabel={getStrings(settings.language).dock.in10min}
          onAcknowledge={(id) => void dismissActive(id, "completed")}
          onSnooze={(id, minutes) => void snoozeActive(id, minutes)}
          onDismiss={(id) => void dismissActive(id, "dismissed")}
          onInteract={dock.interact}
          onDisengage={dock.disengage}
          onKeyDismiss={(id) => void dismissActive(id, "dismissed")}
          onMeasure={handleDockMeasure}
        />
      )}
      {/* Wake-word listening pill: only while the dock is hidden — the
       * dock owns the window whenever a reminder is on screen. While the
       * user speaks, the live STT partial renders as subtext inside the
       * pill; the bubble underneath is reserved for the frozen final
       * while processing, Nila's response, or a gentle error line. */}
      {view === "companion" &&
        (wakeListening || voicePhase !== "idle") &&
        dock.phase === "hidden" && (
          <WakePill
            label={
              voicePhase === "processing"
                ? getStrings(settings.language).voice.processing
                : getStrings(settings.language).wake.listening
            }
            alt={getStrings(settings.language).wake.nilaAlt}
            reducedMotion={settings.animation !== "full" || prefersReducedMotion}
            subtext={
              voicePhase === "listening" || voicePhase === "recording"
                ? voiceText
                : undefined
            }
            transcript={voicePhase === "processing" ? voiceText : undefined}
            error={
              voiceErrorCode
                ? voiceErrorLabel(
                    voiceErrorCode,
                    getStrings(settings.language).voice,
                  )
                : null
            }
            dismissible={voicePhase === "processing" && !voiceErrorCode}
            onDismiss={dismissConversation}
            dismissLabel={getStrings(settings.language).wake.okayNila}
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
        <Suspense fallback={null}>
          <CharacterLab onClose={() => setLabOpen(false)} />
        </Suspense>
      )}
      {view !== "companion" && (
        <div className="panel-wrap" key={panelKey}>
          <SettingsPanel
            settings={settings}
            paused={paused}
            reminders={reminders}
            nativeTitlebar={decorated}
            initialPage={setupMode ? "welcome" : (panelPage ?? undefined)}
            autoNewReminder={panelAutoNew}
            prefillTitle={panelPrefillTitle ?? undefined}
            setupMode={setupMode}
            // Onboarding finished: persist off setup mode and hand the
            // window back to the tray — the main Nila experience.
            onSetupComplete={() => {
              setSetupMode(false);
              hideToTray();
            }}
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
