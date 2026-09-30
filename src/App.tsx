import { useEffect, useRef, useState } from "react";
import { CharacterEngine, NilaCharacter } from "./character";
import type { CharacterSnapshot } from "./character";
import { ONBOARDING, SETTINGS_LABELS } from "./lib/strings";
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
import { ReminderOverlay, type DueReminder } from "./components/ReminderOverlay";
import { SettingsPanel } from "./components/SettingsPanel";
import { RemindersPanel } from "./components/RemindersPanel";

type View = "companion" | "settings" | "reminders";

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

  // Engine -> React state.
  useEffect(() => {
    const off = engineRef.current!.onChange(setSnap);
    return off;
  }, []);

  // First-launch greeting.
  useEffect(() => {
    const t = window.setTimeout(() => {
      engineRef.current!.wave();
      setGreeted(true);
      window.setTimeout(() => engineRef.current!.returnToIdle(), 2500);
    }, 600);
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
            title: "പരീക്ഷണം",
            message: "ഇത് ഒരു പരീക്ഷണ ഓർമ്മപ്പെടുത്തലാണ് 🌸",
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
        engineRef.current!.beginReminder(kind);
        setActiveReminder(r);
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
    if (v === "settings") void refreshSettings();
    setView(v);
  };

  const handleCompanionClick = () => {
    if (activeReminder) return;
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
  };

  const snoozeActive = async (id: string, minutes: 10 | 30 | 60) => {
    try {
      await invokeCommand("snooze_reminder", { id, minutes });
    } catch {
      /* demo mode */
    }
    engineRef.current!.snoozeReminder();
    setActiveReminder(null);
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
    if (!isTauri()) {
      const r: DueReminder = {
        id: "demo",
        title: "വെള്ളം",
        message: "വെള്ളം കുടിച്ചോ? (ഡെമോ)",
        kind: "water",
      };
      engineRef.current!.beginReminder("water");
      setActiveReminder(r);
      return;
    }
    try {
      await invokeCommand("test_reminder");
    } catch {
      /* ignore */
    }
  };

  const saveSettings = async (s: AppSettings) => {
    setSettings(s);
    const engine = engineRef.current!;
    engine.setSize(s.character_size);
    engine.setMotion(s.animation);
    try {
      await invokeCommand("update_settings", { settings: settingsToRecord(s) });
    } catch {
      /* demo mode */
    }
    setView("companion");
  };

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
      aria-label="നില"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") handleCompanionClick();
        if (e.key === "Escape") {
          setView("companion");
          setActiveReminder(null);
        }
      }}
    >
      {snap.visible && (
        <NilaCharacter
          state={snap.state}
          animation={snap.animation}
          size={snap.size}
          dark={dark}
        />
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
          aria-label={SETTINGS_LABELS.general}
          onClick={(e) => {
            e.stopPropagation();
            openPanel("settings");
          }}
        >
          ⚙
        </button>
      )}
      {view !== "companion" && (
        <div className="panel-wrap">
          <div className="tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={view === "settings"}
              className={view === "settings" ? "tab on" : "tab"}
              onClick={() => openPanel("settings")}
            >
              {SETTINGS_LABELS.general}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "reminders"}
              className={view === "reminders" ? "tab on" : "tab"}
              onClick={() => setView("reminders")}
            >
              {SETTINGS_LABELS.reminders}
            </button>
          </div>
          {view === "settings" ? (
            <SettingsPanel
              settings={settings}
              paused={paused}
              onSave={(s) => void saveSettings(s)}
              onPause={(m) => void pauseAll(m)}
              onResume={() => void resumeAll()}
              onTest={() => void testReminder()}
              onClose={() => setView("companion")}
              onDataChanged={() => void reloadAfterImport()}
            />
          ) : (
            <RemindersPanel
              reminders={reminders}
              onToggle={(id, en) => void toggleReminder(id, en)}
              onDelete={(id) => void deleteReminder(id)}
              onCreate={(input) => void createReminder(input)}
              onClose={() => setView("companion")}
            />
          )}
        </div>
      )}
    </div>
  );
}
