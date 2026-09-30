import { useState } from "react";
import { ACTIONS, BUILT_IN_TITLES, SETTINGS_LABELS } from "../lib/strings";
import type { Reminder, ReminderKind, Schedule } from "../lib/types";
import { describeSchedule } from "../lib/reminders";

interface Props {
  reminders: Reminder[];
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
  onCreate: (input: { title: string; message: string; kind: ReminderKind; schedule: Schedule }) => void;
  onClose: () => void;
}

const KINDS: ReminderKind[] = ["water", "food", "break", "move", "sleep", "custom"];
const DAY_NAMES = ["ഞായർ", "തിങ്കൾ", "ചൊവ്വ", "ബുധൻ", "വ്യാഴം", "വെള്ളി", "ശനി"];
const KIND_LABELS: Record<ReminderKind, string> = {
  ...BUILT_IN_TITLES,
  custom: "സ്വന്തം",
} as Record<ReminderKind, string>;

type ScheduleType = Schedule["type"];

/** RemindersPanel — list, enable/disable, delete, and create custom reminders (Phase 9). */
export function RemindersPanel({ reminders, onToggle, onDelete, onCreate, onClose }: Props) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [kind, setKind] = useState<ReminderKind>("custom");
  const [schedType, setSchedType] = useState<ScheduleType>("daily");
  const [time, setTime] = useState("09:00");
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [minutes, setMinutes] = useState(60);
  const [onceAt, setOnceAt] = useState("");

  const toggleDay = (d: number) =>
    setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort()));

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

  const handleCreate = () => {
    const schedule = buildSchedule();
    if (!title.trim() || !message.trim() || !schedule) return;
    onCreate({ title: title.trim(), message: message.trim(), kind, schedule });
    setTitle("");
    setMessage("");
    setAdding(false);
  };

  return (
    <div className="panel" role="dialog" aria-label={SETTINGS_LABELS.reminders}>
      <div className="panel-header">
        <span className="panel-title">{SETTINGS_LABELS.reminders}</span>
        <button type="button" className="icon-btn" onClick={onClose} aria-label={ACTIONS.cancel}>✕</button>
      </div>

      <ul className="reminder-list">
        {reminders.map((r) => (
          <li key={r.id} className="reminder-row">
            <label className="reminder-main">
              <input
                type="checkbox"
                checked={r.enabled}
                onChange={(e) => onToggle(r.id, e.target.checked)}
              />
              <span>
                <span className="reminder-title">{r.title}</span>
                <span className="reminder-sub">{describeSchedule(r.schedule)}</span>
              </span>
            </label>
            <button type="button" className="icon-btn danger" onClick={() => onDelete(r.id)} aria-label={ACTIONS.delete}>
              🗑
            </button>
          </li>
        ))}
        {reminders.length === 0 && <li className="empty">—</li>}
      </ul>

      {!adding ? (
        <button type="button" className="btn primary" onClick={() => setAdding(true)}>
          {ACTIONS.add}
        </button>
      ) : (
        <div className="add-form">
          <input
            type="text"
            placeholder="തലക്കെട്ട്"
            value={title}
            maxLength={80}
            onChange={(e) => setTitle(e.target.value)}
          />
          <input
            type="text"
            placeholder="സന്ദേശം"
            value={message}
            maxLength={280}
            onChange={(e) => setMessage(e.target.value)}
          />
          <span className="field-row">
            <select value={kind} onChange={(e) => setKind(e.target.value as ReminderKind)} aria-label="തരം">
              {KINDS.map((k) => (
                <option key={k} value={k}>{KIND_LABELS[k]}</option>
              ))}
            </select>
            <select value={schedType} onChange={(e) => setSchedType(e.target.value as ScheduleType)} aria-label="സമയക്രമം">
              <option value="daily">ദിവസവും</option>
              <option value="weekly">ആഴ്ചയിൽ</option>
              <option value="interval">ഇടവേള</option>
              <option value="once">ഒറ്റത്തവണ</option>
            </select>
          </span>
          {schedType === "daily" && (
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          )}
          {schedType === "weekly" && (
            <>
              <div className="day-picker">
                {DAY_NAMES.map((name, d) => (
                  <button
                    key={d}
                    type="button"
                    className={days.includes(d) ? "day on" : "day"}
                    onClick={() => toggleDay(d)}
                  >
                    {name.slice(0, 2)}
                  </button>
                ))}
              </div>
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </>
          )}
          {schedType === "interval" && (
            <label className="field">
              <span>മിനിറ്റ്</span>
              <input type="number" min={5} max={1440} value={minutes} onChange={(e) => setMinutes(Number(e.target.value) || 0)} />
            </label>
          )}
          {schedType === "once" && (
            <input type="datetime-local" value={onceAt} onChange={(e) => setOnceAt(e.target.value)} />
          )}
          <span className="field-row">
            <button type="button" className="btn primary" onClick={handleCreate}>{ACTIONS.add}</button>
            <button type="button" className="btn" onClick={() => setAdding(false)}>{ACTIONS.cancel}</button>
          </span>
        </div>
      )}
    </div>
  );
}
