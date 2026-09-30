/**
 * Reminders page — built-in reminders with toggles, custom reminders with
 * an empty state, and the polished reminder editor dialog.
 */
import { useState } from "react";
import {
  describeScheduleIn,
  type Dict,
  type Language,
} from "../../../lib/i18n";
import type { Reminder, ReminderKind } from "../../../lib/types";
import { SettingsRow, SettingsSection, Switch } from "../ui";
import { IconChevronRight, IconPlus, IconReminders } from "../icons";
import { ReminderEditor, type ReminderInput } from "../ReminderEditor";
import idleUrl from "../../../../character/idle.png";

const BUILT_IN_KINDS: ReminderKind[] = ["water", "food", "break", "move", "sleep"];

export function RemindersPage({
  t,
  lang,
  reminders,
  onToggle,
  onDelete,
  onCreate,
  onUpdate,
}: {
  t: Dict;
  lang: Language;
  reminders: Reminder[];
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
  onCreate: (input: ReminderInput) => void;
  onUpdate: (id: string, input: ReminderInput) => void;
}) {
  const r = t.reminders;
  const [editing, setEditing] = useState<Reminder | "new" | null>(null);

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
      </SettingsSection>

      <p className="status-line">{r.editHint}</p>

      {editing && (
        <ReminderEditor
          t={t}
          initial={editing === "new" ? null : editing}
          onSave={handleSave}
          onDelete={handleDelete}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
