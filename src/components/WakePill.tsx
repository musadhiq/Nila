/**
 * WakePill — the small indicator shown at the top of the screen after
 * the wake word is detected.
 *
 * It is deliberately minimal (her attentive face + a living line) and
 * transform/opacity-only, in the same visual language as the
 * notification dock. The dock wins while a reminder is on screen; this
 * pill only renders while the dock is hidden.
 *
 * - While the mic is held, the Lottie voice wave reacts to the user's
 *   speech (speed + amplitude follow the mic level).
 * - While Nila works on the command, a plain heartbeat line pulses
 *   instead of a "Working on it…" label.
 * - While the user speaks, the live STT partial renders as a subtext
 *   line under the wave. The bubble underneath is reserved for the
 * frozen final text while processing, Nila's response, or a gentle
 * error line when nothing was heard.
 */

import { expressionUrl } from "../dock/expressions";
import { VoiceWave } from "./VoiceWave";
import { HeartbeatLine } from "./HeartbeatLine";

interface WakePillProps {
  /** Alt text for Nila's portrait. */
  alt: string;
  /** Disable animations (static wave frame / static heartbeat). */
  reducedMotion: boolean;
  /** True while Nila is working on the command: the heartbeat line
   * shows instead of the voice wave. */
  busy: boolean;
  /** True while the mic is held for the user's speech (listening /
   * recording). The wave is then driven by the live mic level;
   * otherwise it idles at a slow drift. */
  waveActive: boolean;
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

export function WakePill({ alt, reducedMotion, busy, waveActive, subtext, transcript, error, dismissible, onDismiss, dismissLabel }: WakePillProps) {
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
        {busy ? (
          <HeartbeatLine reducedMotion={reducedMotion} />
        ) : (
          <span className="wake-textcol">
            <VoiceWave active={waveActive} reducedMotion={reducedMotion} />
            {sub ? <span className="wake-subtext">{sub}</span> : null}
          </span>
        )}
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
