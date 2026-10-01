import { useEffect, useRef, type ReactNode } from "react";
import type { DockAckAction, DockNotification, DockPhase } from "./dockMachine";
import { ACTIONS } from "../lib/strings";

/**
 * NotificationDock — Nila's V1 notification surface.
 *
 * A minimal white card at the top-center of the screen, hanging just
 * below the system top bar. Nila peeks from the right edge, cropped by
 * the card. A small tick (top-left) marks the reminder done; a slim
 * pinned row offers snooze choices. Exactly one notification shows at a
 * time; the rest queue behind it.
 *
 * The card is presentational: `phase` + `reminder` come from
 * useNotificationDock, Nila's frames come from the character engine
 * (passed in as `nila` so this component stays engine-agnostic).
 */

interface Props {
  phase: DockPhase;
  reminder: DockNotification | null;
  queueCount: number;
  reducedMotion: boolean;
  /** Nila, rendered by the host from the character engine snapshot. */
  nila: ReactNode;
  onDone: (id: string, action: "completed" | "dismissed") => void;
  onSnooze: (id: string, minutes: 10 | 30 | 60) => void;
  onInteract: () => void;
  onDisengage: () => void;
  onKeyDismiss: (id: string) => void;
  /** Reports the card's layout size (unaffected by entry-animation
   *  transforms) so the host can fit the transparent window tightly
   *  around it instead of leaving a large dead click zone. */
  onMeasure?: (w: number, h: number) => void;
}

const PHASE_CLASS: Record<DockPhase, string> = {
  hidden: "is-hidden",
  entering: "is-entering",
  expanding: "is-expanding",
  visible: "is-visible",
  interacting: "is-interacting",
  acknowledging: "is-acknowledging",
  collapsing: "is-collapsing",
};

export function NotificationDock({
  phase,
  reminder,
  queueCount,
  reducedMotion,
  nila,
  onDone,
  onSnooze,
  onInteract,
  onDisengage,
  onKeyDismiss,
  onMeasure,
}: Props) {
  const tickRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const prevPhase = useRef<DockPhase>(phase);

  // When the notification becomes fully visible, move keyboard focus to
  // the tick (the primary action) so the dock is operable without a mouse.
  useEffect(() => {
    if (prevPhase.current !== "visible" && phase === "visible") {
      tickRef.current?.focus({ preventScroll: true });
    }
    prevPhase.current = phase;
  }, [phase]);

  // Report the card's layout size to the host. offsetWidth/offsetHeight
  // are transform-independent, so the entry animation never causes a
  // resize loop; text wrapping, the queue badge, and font loads still
  // update the measurement.
  useEffect(() => {
    const el = cardRef.current;
    if (!el || !onMeasure) return;
    const report = () => onMeasure(el.offsetWidth, el.offsetHeight);
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [onMeasure, reminder?.id]);

  if (phase === "hidden" || !reminder) return null;

  const acking = phase === "acknowledging" || phase === "collapsing";
  const busy = acking || phase === "entering" || phase === "expanding";

  return (
    <div
      className={`dock-root${reducedMotion ? " reduce-motion" : ""}`}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div
        ref={cardRef}
        className={`dock-card ${PHASE_CLASS[phase]}`}
        role="alertdialog"
        aria-label={reminder.title}
        aria-describedby={`dock-msg-${reminder.id}`}
        onMouseEnter={onInteract}
        onMouseLeave={onDisengage}
        onFocus={onInteract}
        onBlur={onDisengage}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !acking) {
            e.stopPropagation();
            onKeyDismiss(reminder.id);
          }
        }}
      >
        <div className="dock-main">
          <div className="dock-head">
            <button
              ref={tickRef}
              type="button"
              className="dock-tick"
              disabled={busy}
              onClick={() => onDone(reminder.id, "completed")}
              aria-label={ACTIONS.ok}
              title={ACTIONS.ok}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path
                  d="M3 8.6l3.1 3.1L13 5.2"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <span className="dock-eyebrow">Nila</span>
            {queueCount > 0 && (
              <span className="dock-queue" aria-label={`${queueCount} more reminders queued`}>
                +{queueCount}
              </span>
            )}
          </div>
          <div className="dock-text">
            <div className="dock-title">{reminder.title}</div>
            <div className="dock-message" id={`dock-msg-${reminder.id}`}>
              {reminder.message}
            </div>
          </div>
          <div className={`dock-foot${busy ? " is-disabled" : ""}`} aria-disabled={busy}>
            <button
              type="button"
              className="dock-snooze"
              disabled={busy}
              onClick={() => onSnooze(reminder.id, 10)}
            >
              {ACTIONS.later}
            </button>
            <button
              type="button"
              className="dock-snooze"
              disabled={busy}
              onClick={() => onSnooze(reminder.id, 30)}
            >
              {ACTIONS.snooze30}
            </button>
            <button
              type="button"
              className="dock-snooze"
              disabled={busy}
              onClick={() => onSnooze(reminder.id, 60)}
            >
              {ACTIONS.snooze60}
            </button>
          </div>
        </div>
        <div className="dock-nila" aria-hidden="true">
          {nila}
        </div>
      </div>
    </div>
  );
}

export type { DockAckAction };
