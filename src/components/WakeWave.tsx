/**
 * WakeWave — Nila's greeting when the wake word is detected.
 *
 * She appears, waves hello (a 3-frame hand-wave cycle built from her
 * own artwork — nothing else moves), and hides again. No listening,
 * no voice commands, no transcription — the wake word is just a hello.
 *
 * Transform/opacity-only, in the same visual language as the
 * notification dock. Reduced-motion safe: a single still frame with
 * a gentle fade.
 */
import { useEffect, useState } from "react";
import waveAUrl from "../../character/expressions/wave-frames/wave-a.png";
import waveBUrl from "../../character/expressions/wave-frames/wave-b.png";
import waveCUrl from "../../character/expressions/wave-frames/wave-c.png";
import "./WakeWave.css";

const FRAMES = [waveAUrl, waveBUrl, waveCUrl, waveBUrl];
/** One wave beat: A → center → C → center, then repeat. */
const FRAME_MS = 220;

interface WakeWaveProps {
  /** Alt text for Nila's portrait. */
  alt: string;
  /** Disable the wave motion (static frame, gentle fade). */
  reducedMotion: boolean;
}

export function WakeWave({ alt, reducedMotion }: WakeWaveProps) {
  const [frame, setFrame] = useState(1);
  useEffect(() => {
    if (reducedMotion) return;
    // Preload the frames so the cycle never flashes.
    for (const src of FRAMES) {
      const im = new Image();
      im.src = src;
    }
    let i = 1;
    const id = window.setInterval(() => {
      i = (i + 1) % FRAMES.length;
      setFrame(i);
    }, FRAME_MS);
    return () => window.clearInterval(id);
  }, [reducedMotion]);
  return (
    <div className="wave-root" role="status" aria-live="polite">
      <div className={`wave-pill${reducedMotion ? " wave-still" : ""}`}>
        <img
          className="wave-face"
          src={reducedMotion ? waveBUrl : FRAMES[frame]}
          alt={alt}
          draggable={false}
        />
      </div>
    </div>
  );
}
