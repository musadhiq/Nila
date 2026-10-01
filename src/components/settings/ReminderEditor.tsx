/**
 * ReminderEditor — a polished dialog for creating/editing a reminder.
 *
 * Progressive disclosure: title/message/type first, then only the fields
 * the chosen schedule needs. Fully keyboard accessible; Escape closes.
 */
import { useEffect, useRef, useState } from "react";
import type { Dict } from "../../lib/i18n";
import type { Reminder, ReminderKind, Schedule } from "../../lib/types";
import { Segmented, TextField } from "./ui";
import { IconTrash } from "./icons";

export interface ReminderInput {
  title: string;
  message: string;
  kind: ReminderKind;
  schedule: Schedule;
}

type ScheduleType = Schedule["type"];

const KINDS: ReminderKind[] = ["water", "food", "break", "move", "stretch", "exercise", "work", "sleep", "custom"];

export function ReminderEditor({
  t,
  initial,
  onSave,
  onDelete,
  onClose,
}: {
  t: Dict;
  initial: Reminder | null;
  onSave: (input: ReminderInput) => void;
  onDelete?: (id: string) => void;
  onClose: () => void;
}) {
  const e = t.reminders.editor;
  const daysShort = t.reminders.schedule.daysShort;

  const [title, setTitle] = useState(initial?.title ?? "");
  const [message, setMessage] = useState(initial?.message ?? "");
  const [kind, setKind] = useState<ReminderKind>(initial?.kind ?? "custom");
  const [schedType, setSchedType] = useState<ScheduleType>(
    initial?.schedule.type ?? "daily",
  );
  const [time, setTime] = useState(
    initial?.schedule.type === "daily" || initial?.schedule.type === "weekly"
      ? initial.schedule.time
      : "09:00",
  );
  const [days, setDays] = useState<number[]>(
    initial?.schedule.type === "weekly" ? initial.schedule.days : [1, 2, 3, 4, 5],
  );
  const [minutes, setMinutes] = useState(
    initial?.schedule.type === "interval" ? initial.schedule.minutes : 60,
  );
  const [onceAt, setOnceAt] = useState(
    initial?.schedule.type === "once" ? toLocalInput(initial.schedule.at) : "",
  );
  const [titleError, setTitleError] = useState("");
  const [messageError, setMessageError] = useState("");
  const [scheduleError, setScheduleError] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const toggleDay = (d: number) =>
    setDays((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort(),
    );

  const buildSchedule = (): Schedule | null => {
    switch (schedType) {
      case "daily":
        return { type: "daily", time };
      case "weekly":
        return days.length > 0 ? { type: "weekly", days, time } : null;
      case "interval":
        return minutes > 0 ? { type: "interval", minutes } : null;
      case "once": {
        if (!onceAt) return null;
        const at = new Date(onceAt).toISOString();
        return Number.isNaN(Date.parse(at)) ? null : { type: "once", at };
      }
    }
  };

  const handleSave = () => {
    const titleBad = !title.trim();
    const messageBad = !message.trim();
    const schedule = buildSchedule();
    const scheduleBad = !schedule;
    setTitleError(titleBad ? e.titleRequired : "");
    setMessageError(messageBad ? e.messageRequired : "");
    setScheduleError(scheduleBad ? e.scheduleRequired : "");
    if (titleBad || messageBad || scheduleBad || !schedule) {
      // Move focus to the first problem for keyboard/screen-reader users.
      if (titleBad) titleRef.current?.focus();
      return;
    }
    onSave({ title: title.trim(), message: message.trim(), kind, schedule });
  };

  return (
    <div
      className="editor-backdrop"
      onMouseDown={(ev) => {
        if (ev.target === ev.currentTarget) onClose();
      }}
    >
      <div
        className="editor"
        role="dialog"
        aria-modal="true"
        aria-label={initial ? e.editTitle : e.newTitle}
      >
        <h2 className="editor-title">{initial ? e.editTitle : e.newTitle}</h2>

        <TextField
          id="re-title"
          label={e.titleLabel}
          value={title}
          onChange={setTitle}
          placeholder={e.titlePlaceholder}
          maxLength={80}
          error={titleError}
          inputRef={titleRef}
        />

        <TextField
          id="re-message"
          label={e.messageLabel}
          value={message}
          onChange={setMessage}
          placeholder={e.messagePlaceholder}
          maxLength={280}
          error={messageError}
        />

        <div className="field">
          <label className="field-label" htmlFor="re-kind">
            {e.typeLabel}
          </label>
          <select
            id="re-kind"
            className="select"
            value={kind}
            onChange={(ev) => setKind(ev.target.value as ReminderKind)}
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {e.kind[k] ?? k}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <span className="field-label" id="re-sched-label">
            {e.scheduleLabel}
          </span>
          <Segmented<ScheduleType>
            label={e.scheduleLabel}
            value={schedType}
            onChange={(v) => {
              setSchedType(v);
              setScheduleError("");
            }}
            options={[
              { value: "daily", label: e.scheduleDaily },
              { value: "weekly", label: e.scheduleWeekly },
              { value: "interval", label: e.scheduleInterval },
              { value: "once", label: e.scheduleOnce },
            ]}
          />
          {scheduleError && (
            <span className="field-error" role="alert">
              {scheduleError}
            </span>
          )}
        </div>

        {(schedType === "daily" || schedType === "weekly") && (
          <div className="field">
            <label className="field-label" htmlFor="re-time">
              {e.timeLabel}
            </label>
            <input
              id="re-time"
              type="time"
              className="time-input"
              value={time}
              onChange={(ev) => setTime(ev.target.value)}
            />
          </div>
        )}

        {schedType === "weekly" && (
          <div className="field">
            <span className="field-label" id="re-days-label">
              {e.daysLabel}
            </span>
            <div
              className="day-picker"
              role="group"
              aria-labelledby="re-days-label"
            >
              {daysShort.map((name, d) => (
                <button
                  key={d}
                  type="button"
                  className="day"
                  aria-pressed={days.includes(d)}
                  aria-label={name}
                  onClick={() => toggleDay(d)}
                >
                  {name}
                </button>
              ))}
            </div>
          </div>
        )}

        {schedType === "interval" && (
          <div className="field">
            <label className="field-label" htmlFor="re-minutes">
              {e.minutesLabel} ({e.minutesUnit})
            </label>
            <input
              id="re-minutes"
              type="number"
              className="number-input"
              min={5}
              max={1440}
              step={5}
              value={minutes}
              onChange={(ev) =>
                setMinutes(Math.max(0, Number(ev.target.value) || 0))
              }
            />
          </div>
        )}

        {schedType === "once" && (
          <div className="field">
            <label className="field-label" htmlFor="re-once">
              {e.onceLabel}
            </label>
            <input
              id="re-once"
              type="datetime-local"
              className="datetime-input"
              value={onceAt}
              onChange={(ev) => setOnceAt(ev.target.value)}
            />
          </div>
        )}

        <div className="editor-actions">
          {initial && onDelete && !confirmingDelete && (
            <button
              type="button"
              className="btn danger-quiet"
              onClick={() => setConfirmingDelete(true)}
            >
              <span
                style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
              >
                <IconTrash />
                {e.delete}
              </span>
            </button>
          )}
          {confirmingDelete && initial && onDelete ? (
            <>
              <span className="field-hint">{e.deleteConfirm}</span>
              <span className="spacer" />
              <button
                type="button"
                className="btn ghost"
                onClick={() => setConfirmingDelete(false)}
              >
                {e.keepEditing}
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={() => onDelete(initial.id)}
              >
                {e.yesDelete}
              </button>
            </>
          ) : (
            <>
              <span className="spacer" />
              <button type="button" className="btn ghost" onClick={onClose}>
                {e.cancel}
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={handleSave}
              >
                {e.save}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Convert an ISO instant to a datetime-local input value. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}
