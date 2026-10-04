/**
 * Reminders page — built-in reminders with toggles, custom reminders with
 * an empty state, and the polished reminder editor dialog.
 */
import { useEffect, useState } from "react";
import {
  describeScheduleIn,
  formatNextIn,
  type Dict,
  type Language,
} from "../../../lib/i18n";
import type { Reminder, ReminderKind } from "../../../lib/types";
import { invokeCommand } from "../../../lib/tauri";
import { SettingsRow, SettingsSection, Switch } from "../ui";
import { IconChevronRight, IconPlus, IconReminders } from "../icons";
import { ReminderEditor, type ReminderInput } from "../ReminderEditor";
import idleUrl from "../../../../character/states/idle.png";

const BUILT_IN_KINDS: ReminderKind[] = ["water", "food", "break", "move", "stretch", "exercise", "work", "sleep"];

/**
 * System health reminders, watched by the backend monitor. They have no
 * editable schedule — the condition *is* the schedule — so the row is
 * toggle-only: no editor, no delete. (The backend re-seeds them by id,
 * so deleting would just bring them back on next launch.)
 */
const SYSTEM_KINDS: ReminderKind[] = ["battery", "cpu", "memory", "disk"];

/** Shape of the backend's startup_report command. */
interface StartupReport {
  issues: { reminder_id: string; reason: string }[];
  next: { id: string; at: string } | null;
}

/** Backend status for the system calendar integration. */
interface SysCalStatus {
  enabled: boolean;
  calendar_count: number;
  last_sync: string | null;
  last_error: string | null;
}

/**
 * System calendar integration (Linux: evolution-data-server).
 * A single toggle: when on, Nila reads the desktop's calendars and
 * creates reminders for upcoming events. No accounts, no network.
 */
function SystemCalendarSection({ t }: { t: Dict }) {
  const r = t.reminders;
  const [status, setStatus] = useState<SysCalStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    invokeCommand<SysCalStatus>("syscal_get_status")
      .then((s) => alive && setStatus(s))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const onToggle = async (v: boolean) => {
    setBusy(true);
    try {
      await invokeCommand("syscal_set_enabled", { enabled: v });
      const s = await invokeCommand<SysCalStatus>("syscal_get_status");
      setStatus(s);
    } catch {
      /* keep the last known status */
    } finally {
      setBusy(false);
    }
  };

  const description = !status
    ? "—"
    : !status.enabled
      ? r.syscalDesc
      : status.calendar_count === 0
        ? r.syscalNoCalendars
        : r.syscalActive.replace("{count}", String(status.calendar_count));

  return (
    <SettingsSection title={r.syscalTitle}>
      <SettingsRow
        title={r.syscalTitle}
        description={description}
        control={
          <Switch
            checked={status?.enabled ?? false}
            onChange={(v) => void onToggle(v)}
            label={r.syscalTitle}
          />
        }
      />
      {busy && (
        <div className="sgroup-pad">
          <p className="status-line">{r.syscalWorking}</p>
        </div>
      )}
    </SettingsSection>
  );
}

export function RemindersPage({
  t,
  lang,
  reminders,
  autoNew,
  openEditorSignal,
  onToggle,
  onDelete,
  onCreate,
  onUpdate,
}: {
  t: Dict;
  lang: Language;
  reminders: Reminder[];
  /** Open the editor immediately (tray "New Reminder"). */
  autoNew?: boolean;
  /** Bump to open the editor from elsewhere (welcome page). */
  openEditorSignal?: number;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
  onCreate: (input: ReminderInput) => void;
  onUpdate: (id: string, input: ReminderInput) => void;
}) {
  const r = t.reminders;
  const [editing, setEditing] = useState<Reminder | "new" | null>(
    autoNew ? "new" : null,
  );

  // Welcome page "Create your first reminder" lands here: open the editor.
  useEffect(() => {
    if (openEditorSignal && openEditorSignal > 0) setEditing("new");
  }, [openEditorSignal]);

  // Ask the backend what it loaded, validated, and scheduled: the
  // scheduler owns all timing; this page only formats its answer.
  const [report, setReport] = useState<StartupReport | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const rep = await invokeCommand<StartupReport>("startup_report");
        if (!cancelled) setReport(rep);
      } catch {
        // Demo mode (plain vite): no backend to ask.
      }
    };
    void load();
    const timer = window.setInterval(load, 60000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [reminders]);

  let nextLine: string | null = null;
  if (report) {
    if (!report.next) {
      nextLine = r.nextNone;
    } else {
      const next = report.next;
      const when = formatNextIn(next.at, lang);
      const found = reminders.find((x) => x.id === next.id);
      const label = found ? `${r.nextTitle}: ${found.title}` : r.nextTitle;
      nextLine = when ? `${label} · ${when}` : label;
    }
  }

  const byKind = (kind: ReminderKind) => reminders.find((x) => x.kind === kind);
  const custom = reminders.filter((x) => x.kind === "custom");

  const handleSave = (input: ReminderInput) => {
    if (editing === "new" || editing === null) {
      onCreate(input);
    } else {
      onUpdate(editing.id, input);
    }
    setEditing(null);
  };

  const handleDelete = (id: string) => {
    onDelete(id);
    setEditing(null);
  };

  return (
    <div className="settings-content-inner">
      <SettingsSection title={r.builtInSection}>
        {(nextLine || (report && report.issues.length > 0)) && (
          <div className="sgroup-pad">
            {nextLine && <p className="status-line">{nextLine}</p>}
            {report && report.issues.length > 0 && (
              <p className="status-line err">{r.dataIssue}</p>
            )}
          </div>
        )}
        {BUILT_IN_KINDS.map((kind) => {
          const rem = byKind(kind);
          if (!rem) return null;
          return (
            <SettingsRow
              key={rem.id}
              title={rem.title}
              description={describeScheduleIn(rem.schedule, lang)}
              onActivate={() => setEditing(rem)}
              control={
                <>
                  <Switch
                    checked={rem.enabled}
                    onChange={(v) => onToggle(rem.id, v)}
                    label={`${r.enabled}: ${rem.title}`}
                  />
                  <IconChevronRight className="srow-chevron" />
                </>
              }
            />
          );
        })}
      </SettingsSection>

      <SystemCalendarSection t={t} />

      <SettingsSection title={r.systemSection}>
        {SYSTEM_KINDS.map((kind) => {
          const rem = byKind(kind);
          if (!rem) return null;
          return (
            <SettingsRow
              key={rem.id}
              title={rem.title}
              description={describeScheduleIn(rem.schedule, lang)}
              control={
                <Switch
                  checked={rem.enabled}
                  onChange={(v) => onToggle(rem.id, v)}
                  label={`${r.enabled}: ${rem.title}`}
                />
              }
            />
          );
        })}
      </SettingsSection>

      <SettingsSection title={r.customSection}>
        {custom.length === 0 ? (
          <div className="empty-state">
            <img src={idleUrl} alt="" draggable={false} />
            <p className="empty-title">{r.emptyCustom}</p>
            <p className="empty-desc">{r.emptyCustomDesc}</p>
            <button
              type="button"
              className="btn primary"
              onClick={() => setEditing("new")}
            >
              <span
                style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
              >
                <IconPlus />
                {r.newReminder}
              </span>
            </button>
          </div>
        ) : (
          <>
            {custom.map((rem) => (
              <SettingsRow
                key={rem.id}
                title={rem.title}
                description={describeScheduleIn(rem.schedule, lang)}
                onActivate={() => setEditing(rem)}
                control={
                  <>
                    <Switch
                      checked={rem.enabled}
                      onChange={(v) => onToggle(rem.id, v)}
                      label={`${r.enabled}: ${rem.title}`}
                    />
                    <IconChevronRight className="srow-chevron" />
                  </>
                }
              />
            ))}
            <SettingsRow
              title={r.newReminder}
              onActivate={() => setEditing("new")}
              control={
                <span className="srow-icon">
                  <IconReminders />
                </span>
              }
            />
          </>
        )}
        <div className="sgroup-pad">
          <p className="status-line">{r.editHint}</p>
        </div>
      </SettingsSection>

      {editing && (
        <ReminderEditor
          t={t}
          initial={
            editing === "new" ? null : editing
          }
          onSave={handleSave}
          onDelete={handleDelete}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
