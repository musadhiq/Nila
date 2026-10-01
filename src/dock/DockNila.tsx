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
import { dockNilaAnimClass, dockNilaAnimForReaction } from "./dockNilaAnim";

const CROSSFADE_MS = 240;
const BLINK_MS = 180;
const BLINK_MIN_GAP_MS = 3200;
const BLINK_MAX_GAP_MS = 7000;

/**
 * Irregular blink beat. Returns true for ~180ms on a randomized
 * 3.2–7s cadence, like a natural blink rhythm. Disabled entirely under
 * reduced motion.
 */
function useBlinkBeat(enabled: boolean): boolean {
  const [blinking, setBlinking] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let timer = 0;
    const loop = () => {
      const gap = BLINK_MIN_GAP_MS + Math.random() * (BLINK_MAX_GAP_MS - BLINK_MIN_GAP_MS);
      timer = window.setTimeout(() => {
        if (!alive) return;
        setBlinking(true);
        timer = window.setTimeout(() => {
          if (!alive) return;
          setBlinking(false);
          loop();
        }, BLINK_MS);
      }, gap);
    };
    loop();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [enabled]);
  return blinking;
}

interface DockNilaFigureProps {
  /** Current expression image URL. */
  src: string;
  alt: string;
  /** Active reaction slot (happy/sad/annoyed), or null while idle. */
  reaction: ExpressionSlot | null;
  reducedMotion: boolean;
}

export function DockNilaFigure({ src, alt, reaction, reducedMotion }: DockNilaFigureProps) {
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

  const blinking = useBlinkBeat(!reducedMotion);
  const animClass = reducedMotion ? "" : dockNilaAnimClass(dockNilaAnimForReaction(reaction));

  const figClass = ["dock-nila-fig", blinking && !reducedMotion ? "is-blink" : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={figClass}>
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
      </div>
    </div>
  );
}
