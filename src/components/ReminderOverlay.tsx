import { ACTIONS } from "../lib/strings";

/** Reminder payload as emitted by the Rust backend on REMINDER_DUE. */
export interface DueReminder {
  id: string;
  title: string;
  message: string;
  kind: string;
}

interface Props {
  reminder: DueReminder;
  onDone: (id: string, action: "dismissed" | "completed") => void;
  onSnooze: (id: string, minutes: 10 | 30 | 60) => void;
  onPause: () => void;
  /** Render as a flex item inside the presence layout instead of a
   *  full-window overlay (spec 46: the bubble adapts to Nila's position). */
  inLayout?: boolean;
}

/**
 * ReminderOverlay — the reminder bubble (Phase 8). Appears over the
 * companion when a reminder fires, with Malayalam actions: done,
 * dismiss, snooze (10/30/60), or pause all reminders for 30 minutes.
 */
export function ReminderOverlay({ reminder, onDone, onSnooze, onPause, inLayout }: Props) {
  return (
    <div className={`overlay${inLayout ? " overlay-in-layout" : ""}`}>
      <div className="overlay-card" role="alertdialog" aria-label={reminder.title}>
        <div className="overlay-title">{reminder.title}</div>
        <div className="overlay-message">{reminder.message}</div>
        <div className="overlay-actions">
          <button type="button" className="btn primary" onClick={() => onDone(reminder.id, "completed")}>
            {ACTIONS.ok}
          </button>
          <button type="button" className="btn" onClick={() => onDone(reminder.id, "dismissed")}>
            {ACTIONS.dismiss}
          </button>
        </div>
        <div className="overlay-actions">
          <button type="button" className="btn small" onClick={() => onSnooze(reminder.id, 10)}>
            {ACTIONS.snooze10}
          </button>
          <button type="button" className="btn small" onClick={() => onSnooze(reminder.id, 30)}>
            {ACTIONS.snooze30}
          </button>
          <button type="button" className="btn small" onClick={() => onSnooze(reminder.id, 60)}>
            {ACTIONS.snooze60}
          </button>
        </div>
        <div className="overlay-actions">
          <button type="button" className="btn small ghost" onClick={onPause}>
            {ACTIONS.pause30}
          </button>
        </div>
      </div>
    </div>
  );
}
