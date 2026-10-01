// useFramePlayback — drives the engine's frame sequences with timers.
//
// The engine owns *which* sequence plays; this hook owns *when* frames
// advance. It also injects the blink frame over the idle loop at an
// irregular 3.5-7s cadence. Under reduced/off motion it does nothing:
// the engine disables frame sequences there and Nila holds her static
// pose (spec 23).

import { useEffect } from "react";
import type { CharacterEngine, CharacterSnapshot } from "./engine";
import { nextBlinkDelayMs } from "./motionManifest";
import { BLINK_KEY } from "./motionManifest";

export function useFramePlayback(
  engine: CharacterEngine | null,
  snap: CharacterSnapshot,
): void {
  const frame = snap.frame;
  const seqKey = frame ? `${frame.sequence}:${frame.key}:${frame.index}` : null;

  // Advance the active sequence on each frame's own timing.
  useEffect(() => {
    if (!engine || !frame) return;
    if (snap.motion !== "full") return;
    if (frame.sequence === "flash") return; // flash has its own timer
    const t = window.setTimeout(() => {
      engine.advanceFrame();
    }, Math.max(30, frame.ms));
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, seqKey, snap.motion]);

  // Blink injector: occasionally flash the blink frame over the idle
  // loop. Never during other states, never over expressions, never
  // twice in a row without the underlying sequence resuming.
  const blinkEnabled =
    snap.motion === "full" &&
    snap.state === "idle" &&
    snap.idleBehavior === "normal" &&
    !snap.expression;
  useEffect(() => {
    if (!engine || !blinkEnabled) return;
    let alive = true;
    let t = 0;
    const schedule = () => {
      if (!alive) return;
      t = window.setTimeout(() => {
        if (!alive) return;
        // Only blink over a settled idle loop — never mid-sequence.
        const s = engine.snapshot();
        if (
          s.state === "idle" &&
          (s.sequence === "idle" || s.sequence === null) &&
          !s.expression
        ) {
          engine.flashFrame(BLINK_KEY);
          t = window.setTimeout(() => {
            if (!alive) return;
            engine.clearFlash();
            schedule();
          }, 170);
        } else {
          schedule(); // not a good moment; try again later
        }
      }, nextBlinkDelayMs());
    };
    schedule();
    return () => {
      alive = false;
      window.clearTimeout(t);
      // Never leave a blink override stuck if the moment passes.
      engine.clearFlash();
    };
  }, [engine, blinkEnabled]);
}
