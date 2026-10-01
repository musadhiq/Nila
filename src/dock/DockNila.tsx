/**
 * DockNilaFigure — Nila's portrait inside the notification dock, with
 * gentle life: a slow idle breathe, irregular blink beats, smooth
 * crossfades between expressions, and one-shot contextual reactions.
 *
 * Layout is unchanged: this renders inside `.dock-nila` exactly where the
 * old static img sat. All motion is transform/opacity only and is fully
 * disabled when `reducedMotion` is set.
 */

import { useEffect, useRef, useState, type ImgHTMLAttributes } from "react";
import type { ExpressionSlot } from "./expressionSlots";
import { expressionUrl } from "./expressions";
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
 *
 * `playSignal` is an on-demand blink: each increment plays one
 * half->closed->half beat immediately (used for the subtle
 * acknowledge blink on done/snooze).
 */
function useBlinkPhase(
  enabled: boolean,
  resetKey: string,
  playSignal: number,
): BlinkPhase {
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
  // An explicit blink request (done/snooze): one beat, right now.
  useEffect(() => {
    if (!enabled || playSignal === 0) return;
    let alive = true;
    let timer = 0;
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
        }, BLINK_HALF_MS);
      }, BLINK_CLOSED_MS);
    }, BLINK_HALF_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [enabled, playSignal]);
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
  /** Active reaction slot (sad/annoyed on dismissal), or null otherwise. */
  reaction: ExpressionSlot | null;
  /** Increment to play one immediate blink beat (done/snooze acknowledge). */
  blinkSignal: number;
  reducedMotion: boolean;
}

/**
 * An <img> that never renders a broken-image icon: on error it falls back
 * once to a guaranteed slot (the curious greeting face), and only if that
 * also fails does it unmount, leaving the figure box empty. Either way the
 * dock card layout is untouched. Keyed by src by the caller, so each new
 * src starts fresh.
 */
function SafeImg({
  fallbackSrc,
  ...props
}: ImgHTMLAttributes<HTMLImageElement> & { fallbackSrc?: string }) {
  // 0: primary src, 1: fallback, 2: give up (unmount).
  const [stage, setStage] = useState(0);
  const effectiveSrc = stage === 0 ? props.src : fallbackSrc;
  if (stage >= 2 || !effectiveSrc) return null;
  return (
    <img
      {...props}
      src={effectiveSrc}
      decoding="async"
      onError={() => setStage((s) => s + 1)}
    />
  );
}

/** Blink-frame URLs already warmed this session (per-slot preload). */
const warmedBlinkUrls = new Set<string>();

export function DockNilaFigure({ slot, src, alt, reaction, blinkSignal, reducedMotion }: DockNilaFigureProps) {
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

  const blinkPhase = useBlinkPhase(!reducedMotion, current, blinkSignal);
  const animClass = reducedMotion ? "" : dockNilaAnimClass(dockNilaAnimForReaction(reaction));

  // Preload this slot's blink frames so the first beat swaps instantly.
  // Skipped under reduced motion (the overlay never renders there — no
  // point decoding ~20 MiB of lids) and deduped per session.
  useEffect(() => {
    if (reducedMotion) return;
    const frames = blinkFrames(slot);
    for (const url of [frames.half, frames.closed]) {
      if (warmedBlinkUrls.has(url)) continue;
      warmedBlinkUrls.add(url);
      const img = new Image();
      img.src = url;
    }
  }, [slot, reducedMotion]);

  // Hard-cut overlay: a real blink swaps lid frames, it doesn't fade.
  const blinkSrc =
    !reducedMotion && blinkPhase ? blinkFrames(slot)[blinkPhase] : null;

  return (
    <div className="dock-nila-fig">
      <div className="dock-nila-xfade">
        {previous && !reducedMotion && (
          <SafeImg key={`prev-${previous}`} src={previous} alt="" aria-hidden className="is-prev" draggable={false} />
        )}
        {/* Keyed by src+reaction so a new reaction replays its one-shot. */}
        <SafeImg
          key={`${current}-${reaction ?? "none"}`}
          src={current}
          fallbackSrc={expressionUrl("greeting")}
          alt={alt}
          className={previous && !reducedMotion ? `is-new ${animClass}`.trim() : animClass}
          draggable={false}
        />
        {blinkSrc && (
          <SafeImg
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
