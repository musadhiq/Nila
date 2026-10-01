/**
 * WakePill — the small "Nila is listening" indicator shown at the top of
 * the screen after the wake word is detected.
 *
 * It is deliberately minimal (her attentive face + one word + a soft
 * pulse dot) and transform/opacity-only, in the same visual language as
 * the notification dock. The dock wins while a reminder is on screen;
 * this pill only renders while the dock is hidden.
 */

import { expressionUrl } from "../dock/expressions";

interface WakePillProps {
  /** Localized "Listening…" label. */
  label: string;
  /** Alt text for Nila's portrait. */
  alt: string;
  /** Disable the pulse animation. */
  reducedMotion: boolean;
}

export function WakePill({ label, alt, reducedMotion }: WakePillProps) {
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
    </div>
  );
}
