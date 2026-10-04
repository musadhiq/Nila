/**
 * WakeWave — Nila's greeting when the wake word is detected.
 *
 * She appears, waves hello (an APNG loop of her actual wave
 * animation), and hides again. No listening, no voice commands, no
 * transcription — the wake word is just a hello.
 *
 * Transform/opacity-only entrance, in the same visual language as the
 * notification dock. Reduced-motion safe: a static frame with a
 * gentle fade.
 */
import waveHelloUrl from "../../character/emotions/wave-hello.apng";
import idleUrl from "../../character/emotions/idle.apng";
import "./WakeWave.css";

interface WakeWaveProps {
  /** Alt text for Nila's portrait. */
  alt: string;
  /** Disable the wave motion (static idle frame, gentle fade). */
  reducedMotion: boolean;
}

export function WakeWave({ alt, reducedMotion }: WakeWaveProps) {
  return (
    <div className="wave-root" role="status" aria-live="polite">
      <div className="wave-pill">
        <img
          className="wave-face"
          src={reducedMotion ? idleUrl : waveHelloUrl}
          alt={alt}
          draggable={false}
        />
      </div>
    </div>
  );
}
