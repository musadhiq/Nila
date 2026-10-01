/**
 * WakePill — the small "Nila is listening" indicator shown at the top of
 * the screen after the wake word is detected.
 *
 * It is deliberately minimal (her attentive face + one word + a soft
 * pulse dot) and transform/opacity-only, in the same visual language as
 * the notification dock. The dock wins while a reminder is on screen;
 * this pill only renders while the dock is hidden.
 *
 * During a voice session the pill grows a transcript bubble underneath:
 * live partial text while the user speaks, the frozen final text while
 * processing, or a gentle error line when nothing was heard.
 */

import { expressionUrl } from "../dock/expressions";

interface WakePillProps {
  /** Localized pill label ("Listening…" / "Working on it…"). */
  label: string;
  /** Alt text for Nila's portrait. */
  alt: string;
  /** Disable the pulse animation. */
  reducedMotion: boolean;
  /** Live or final transcript; the bubble renders when non-empty. */
  transcript?: string;
  /** Localized error line; the bubble renders in an error tone. */
  error?: string | null;
}

export function WakePill({ label, alt, reducedMotion, transcript, error }: WakePillProps) {
  const bubbleText = error ?? (transcript && transcript.trim().length > 0 ? transcript : null);
  return (
    <div className="wake-root" role="status" aria-live="polite">
      <div className="wake-pill">
        <img
          className="wake-face"
          src={expressionUrl("greeting")}
          alt={alt}
          draggable={false}
        />
        <span className="wake-label">{label}</span>
        <span
          className={reducedMotion ? "wake-dot is-still" : "wake-dot"}
          aria-hidden="true"
        />
      </div>
      {bubbleText ? (
        <div className={error ? "wake-bubble is-error" : "wake-bubble"}>{bubbleText}</div>
      ) : null}
    </div>
  );
}
