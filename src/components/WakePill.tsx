/**
 * WakePill — the small "Nila is listening" indicator shown at the top of
 * the screen after the wake word is detected.
 *
 * It is deliberately minimal (her attentive face + one word + a soft
 * pulse dot) and transform/opacity-only, in the same visual language as
 * the notification dock. The dock wins while a reminder is on screen;
 * this pill only renders while the dock is hidden.
 *
 * While the user speaks, the live STT partial renders as a subtext line
 * inside the pill, under the label. The bubble underneath is reserved
 * for the frozen final text while processing, Nila's response, or a
 * gentle error line when nothing was heard.
 */

import { expressionUrl } from "../dock/expressions";

interface WakePillProps {
  /** Localized pill label ("Listening…" / "Working on it…"). */
  label: string;
  /** Alt text for Nila's portrait. */
  alt: string;
  /** Disable the pulse animation. */
  reducedMotion: boolean;
  /** Live partial transcript; renders as subtext inside the pill when non-empty. */
  subtext?: string;
  /** Frozen final transcript or Nila's response; the bubble renders when non-empty. */
  transcript?: string;
  /** Localized error line; the bubble renders in an error tone. */
  error?: string | null;
  /** Show dismiss controls (Okay Nila button + ×) in the bubble. */
  dismissible?: boolean;
  /** Called when the user dismisses via Okay Nila or ×. */
  onDismiss?: () => void;
  /** Localized label for the Okay Nila button. */
  dismissLabel?: string;
}

export function WakePill({ label, alt, reducedMotion, subtext, transcript, error, dismissible, onDismiss, dismissLabel }: WakePillProps) {
  const bubbleText = error ?? (transcript && transcript.trim().length > 0 ? transcript : null);
  const sub = subtext && subtext.trim().length > 0 ? subtext : null;
  const showDismiss = dismissible && onDismiss && bubbleText && !error;
  return (
    <div className="wake-root" role="status" aria-live="polite">
      <div className="wake-pill">
        <img
          className="wake-face"
          src={expressionUrl("greeting")}
          alt={alt}
          draggable={false}
        />
        <span className="wake-textcol">
          <span className="wake-label">{label}</span>
          {sub ? <span className="wake-subtext">{sub}</span> : null}
        </span>
        <span
          className={reducedMotion ? "wake-dot is-still" : "wake-dot"}
          aria-hidden="true"
        />
      </div>
      {bubbleText ? (
        <div className={error ? "wake-bubble is-error" : "wake-bubble"}>
          {showDismiss ? (
            <button
              type="button"
              className="wake-dismiss-x"
              onClick={onDismiss}
              aria-label={dismissLabel ?? "Dismiss"}
            >
              ×
            </button>
          ) : null}
          <span className="wake-bubble-text">{bubbleText}</span>
          {showDismiss ? (
            <button
              type="button"
              className="wake-dismiss-btn"
              onClick={onDismiss}
            >
              {dismissLabel ?? "Okay Nila"}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
