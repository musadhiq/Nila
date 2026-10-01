import { useEffect, useRef, type ReactNode } from "react";
import type { DockAckAction, DockNotification, DockPhase } from "./dockMachine";

/**
 * NotificationDock — Nila's V1 notification surface.
 *
 * A chat-bubble card at the top-center of the screen, hanging just below
 * the system top bar. Nila leans in over the bubble's top-left corner
 * (peek-top-left frames); the bubble carries a left-pointing tail, the
 * title with a close button, and two quick-reply pills: Okay (done) and
 * In 10 min (snooze). Exactly one notification shows at a time; the rest
 * queue behind it.
 *
 * The card auto-hides after 15 seconds (see useNotificationDock) and a
 * click anywhere on the card dismisses it. Minimal and powerful: no
 * tick, no badge, no extra chrome.
 *
 * The card is presentational: `phase` + `reminder` come from
 * useNotificationDock, Nila's frames come from the character engine
 * (passed in as `nila` so this component stays engine-agnostic).
 */

interface Props {
  phase: DockPhase;
  reminder: DockNotification | null;
  reducedMotion: boolean;
  /** Nila, rendered by the host from the character engine snapshot. */
  nila: ReactNode;
  okayLabel: string;
  snoozeLabel: string;
  /** "Okay" pill: marks the reminder done. */
  onAcknowledge: (id: string) => void;
  /** "In 10 min" pill: snoozes the reminder. */
  onSnooze: (id: string, minutes: 10) => void;
  /** Close button, card click, Escape, and the 15s auto-hide. */
  onDismiss: (id: string) => void;
  onInteract: () => void;
  onDisengage: () => void;
  onKeyDismiss: (id: string) => void;
  /** Reports the wrap's layout size (unaffected by entry-animation
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
  reducedMotion,
  nila,
  okayLabel,
  snoozeLabel,
  onAcknowledge,
  onSnooze,
  onDismiss,
  onInteract,
  onDisengage,
  onKeyDismiss,
  onMeasure,
}: Props) {
  const okayRef = useRef<HTMLButtonElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const prevPhase = useRef<DockPhase>(phase);

  // When the notification becomes fully visible, move keyboard focus to
  // the Okay pill (the primary action) so the dock is operable
  // without a mouse.
  useEffect(() => {
    if (prevPhase.current !== "visible" && phase === "visible") {
      okayRef.current?.focus({ preventScroll: true });
    }
    prevPhase.current = phase;
  }, [phase]);

  // Report the wrap's layout size to the host. offsetWidth/offsetHeight
  // are transform-independent, so the entry animation never causes a
  // resize loop; text wrapping and font loads still update it.
  useEffect(() => {
    const el = wrapRef.current;
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
  const showMessage =
    reminder.message.trim().length > 0 &&
    reminder.message.trim() !== reminder.title.trim();

  return (
    <div
      className={`dock-root${reducedMotion ? " reduce-motion" : ""}`}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div ref={wrapRef} className={`dock-wrap ${PHASE_CLASS[phase]}`}>
        <div className="dock-nila" aria-hidden="true">
          {nila}
        </div>
        <div
          className="dock-card"
          role="alertdialog"
          aria-label={reminder.title}
          aria-describedby={`dock-msg-${reminder.id}`}
          onClick={() => {
            if (!acking) onDismiss(reminder.id);
          }}
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
          <div className="dock-title-row">
            <span className="dock-title">{reminder.title}</span>
            <button
              type="button"
              className="dock-x"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                onDismiss(reminder.id);
              }}
              aria-label="Close"
            >
              ×
            </button>
          </div>
          {showMessage && (
            <div className="dock-message" id={`dock-msg-${reminder.id}`}>
              {reminder.message}
            </div>
          )}
          <div className="dock-pills">
            <button
              ref={okayRef}
              type="button"
              className="dock-pill"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                onAcknowledge(reminder.id);
              }}
            >
              {okayLabel}
            </button>
            <button
              type="button"
              className="dock-pill"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                onSnooze(reminder.id, 10);
              }}
            >
              {snoozeLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export type { DockAckAction };
