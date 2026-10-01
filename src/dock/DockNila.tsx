/**
 * DockNilaFigure — Nila's portrait inside the notification dock, with
 * gentle life: a slow idle breathe, irregular blink beats, smooth
 * crossfades between expressions, and one-shot contextual reactions.
 *
 * Layout is unchanged: this renders inside `.dock-nila` exactly where the
 * old static img sat. All motion is transform/opacity only and is fully
 * disabled when `reducedMotion` is set.
 */

import { useEffect, useRef, useState } from "react";
import type { ExpressionSlot } from "./expressionSlots";
import { blinkFrames } from "./blinkFrames";
import { dockNilaAnimClass, dockNilaAnimForReaction } from "./dockNilaAnim";

const CROSSFADE_MS = 240;
const BLINK_HALF_MS = 60;
const BLINK_CLOSED_MS = 70;
const BLINK_MIN_GAP_MS = 3200;
const BLINK_MAX_GAP_MS = 7000;

/** A blink beat plays half-blink -> fully-closed -> half-blink, like a real lid. */
type BlinkPhase = "half" | "closed" | null;

/**
 * Irregular blink beat. Yields the current blink frame phase on a
 * randomized 3.2–7s cadence, like a natural blink rhythm. Disabled
 * entirely under reduced motion.
 */
function useBlinkPhase(enabled: boolean, resetKey: string): BlinkPhase {
  const [phase, setPhase] = useState<BlinkPhase>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let timer = 0;
    const loop = () => {
      const gap =
        BLINK_MIN_GAP_MS + Math.random() * (BLINK_MAX_GAP_MS - BLINK_MIN_GAP_MS);
      timer = window.setTimeout(() => {
        if (!alive) return;
        setPhase("half");
        timer = window.setTimeout(() => {
          if (!alive) return;
          setPhase("closed");
          timer = window.setTimeout(() => {
            if (!alive) return;
            setPhase("half");
            timer = window.setTimeout(() => {
              if (!alive) return;
              setPhase(null);
              loop();
            }, BLINK_HALF_MS);
          }, BLINK_CLOSED_MS);
        }, BLINK_HALF_MS);
      }, gap);
    };
    loop();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [enabled]);
  // A new expression cancels a mid-blink beat so a stale frame from the
  // previous face can never overlay the incoming one.
  useEffect(() => {
    setPhase(null);
  }, [resetKey]);
  return phase;
}

interface DockNilaFigureProps {
  /** Current expression slot — selects the matching blink frames. */
  slot: ExpressionSlot;
  /** Current expression image URL. */
  src: string;
  alt: string;
  /** Active reaction slot (happy/sad/annoyed), or null while idle. */
  reaction: ExpressionSlot | null;
  reducedMotion: boolean;
}

export function DockNilaFigure({ slot, src, alt, reaction, reducedMotion }: DockNilaFigureProps) {
  // Crossfade bookkeeping: keep the previous src mounted briefly so the
  // old expression fades out under the incoming one.
  const [[current, previous], setPair] = useState<[string, string | null]>([src, null]);
  const firstRender = useRef(true);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    setPair(([cur]) => (cur === src ? [cur, null] : [src, cur]));
  }, [src]);

  useEffect(() => {
    if (!previous) return;
    const t = window.setTimeout(() => setPair(([cur]) => [cur, null]), CROSSFADE_MS);
    return () => window.clearTimeout(t);
  }, [previous]);

  const blinkPhase = useBlinkPhase(!reducedMotion, current);
  const animClass = reducedMotion ? "" : dockNilaAnimClass(dockNilaAnimForReaction(reaction));

  // Preload this slot's blink frames so the first beat swaps instantly.
  useEffect(() => {
    const frames = blinkFrames(slot);
    for (const url of [frames.half, frames.closed]) {
      const img = new Image();
      img.src = url;
    }
  }, [slot]);

  // Hard-cut overlay: a real blink swaps lid frames, it doesn't fade.
  const blinkSrc =
    !reducedMotion && blinkPhase ? blinkFrames(slot)[blinkPhase] : null;

  return (
    <div className="dock-nila-fig">
      <div className="dock-nila-xfade">
        {previous && !reducedMotion && (
          <img key={`prev-${previous}`} src={previous} alt="" aria-hidden className="is-prev" draggable={false} />
        )}
        {/* Keyed by src+reaction so a new reaction replays its one-shot. */}
        <img
          key={`${current}-${reaction ?? "none"}`}
          src={current}
          alt={alt}
          className={previous && !reducedMotion ? `is-new ${animClass}`.trim() : animClass}
          draggable={false}
        />
        {blinkSrc && (
          <img
            key={blinkSrc}
            src={blinkSrc}
            alt=""
            aria-hidden
            className="dock-nila-blink"
            draggable={false}
          />
        )}
      </div>
    </div>
  );
}
