/**
 * VoiceWave — Nila's listening indicator, driven by the user's voice.
 *
 * Instead of a free-running pulse, this plays the Lottie voice-line
 * wave and modulates it from the live mic level (`voice:level`,
 * ~16 Hz from the Rust capture loop):
 *
 * - playback speed follows speech energy (idle drift → lively), and
 * - the wave's vertical amplitude scales with the level.
 *
 * The component subscribes to the level events itself and smooths
 * everything in a rAF loop, so no React re-renders happen per event.
 * When `active` is false (e.g. the "Working on it…" phase) or the
 * level stream goes quiet, the wave decays to a slow idle drift.
 * With reduced motion it renders a single static frame.
 *
 * lottie-web is loaded lazily so the main bundle stays lean — the
 * player chunk only loads the first time the voice pill appears.
 */

import { useEffect, useRef } from "react";
import type { AnimationItem } from "lottie-web";
import { listenEvent } from "../lib/tauri.ts";
import { VOICE_EVENTS, type VoiceLevelPayload } from "../lib/voice.ts";

/** Idle drift speed when nobody is speaking. */
const IDLE_SPEED = 0.35;
/** Extra speed at full level. */
const ACTIVE_SPEED = 2.0;
/** How fast the displayed level chases the target (per frame). */
const SMOOTHING = 0.18;
/** No level event for this long → treat as silence. */
const LEVEL_STALE_MS = 600;

interface VoiceWaveProps {
  /** True while the mic is held for the user's speech. */
  active: boolean;
  /** Render one static frame and never animate. */
  reducedMotion: boolean;
}

export function VoiceWave({ active, reducedMotion }: VoiceWaveProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    let anim: AnimationItem | null = null;
    let raf = 0;
    let unlisten: (() => void) | null = null;

    void Promise.all([import("lottie-web"), import("../assets/voice-wave.json")]).then(
      ([lottieMod, waveMod]) => {
        if (cancelled || !containerRef.current) return;
        const lottie = lottieMod.default;
        // The extracted animation JSON from the provided .lottie file.
        const waveData = waveMod.default;
        const el = containerRef.current;

        anim = lottie.loadAnimation({
          container: el,
          renderer: "svg",
          loop: true,
          autoplay: false,
          animationData: waveData,
          rendererSettings: {
            // Wide, short pill slot: fill the width, crop the empty
            // canvas above/below the wave line.
            preserveAspectRatio: "xMidYMid slice",
          },
        });

        if (reducedMotion) {
          anim.goToAndStop(0, true);
          return;
        }

        const levelRef = { level: 0, at: 0 };
        let smooth = 0;
        let lastSpeed = -1;

        void listenEvent<VoiceLevelPayload>(VOICE_EVENTS.level, (p) => {
          const v = typeof p.level === "number" ? p.level : 0;
          levelRef.level = Math.min(1, Math.max(0, v));
          levelRef.at = performance.now();
        }).then((u) => {
          if (cancelled) u();
          else unlisten = u;
        });

        anim.play();

        const tick = () => {
          if (cancelled) return;
          raf = requestAnimationFrame(tick);
          const fresh = performance.now() - levelRef.at < LEVEL_STALE_MS;
          const target = activeRef.current && fresh ? levelRef.level : 0;
          smooth += (target - smooth) * SMOOTHING;
          if (Math.abs(target - smooth) < 0.001) smooth = target;

          const speed = IDLE_SPEED + smooth * ACTIVE_SPEED;
          if (Math.abs(speed - lastSpeed) > 0.02 && anim) {
            anim.setSpeed(speed);
            lastSpeed = speed;
          }
          // Amplitude follows the voice: quiet → a thin idle line.
          el.style.transform = `scaleY(${(0.45 + smooth * 0.55).toFixed(3)})`;
        };
        raf = requestAnimationFrame(tick);
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      if (unlisten) unlisten();
      if (anim) anim.destroy();
    };
  }, [reducedMotion]);

  return <div className="wake-wave" ref={containerRef} aria-hidden="true" />;
}
