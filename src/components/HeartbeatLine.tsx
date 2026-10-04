/**
 * HeartbeatLine — the "working" indicator in the wake pill.
 *
 * While Nila processes a command (the old "Working on it…" text), the
 * pill shows a plain ECG-style heartbeat line: a flat trace with a
 * rhythmic pulse scrolling through it, fading at both edges like a
 * monitor. Pure SVG + CSS, no player needed. Static under reduced
 * motion.
 */

interface HeartbeatLineProps {
  /** Render a static trace and never animate. */
  reducedMotion: boolean;
}

/** One 60px heartbeat period; tiled for a seamless scroll loop. */
const BEAT =
  "M0 17 H14 L19 17 L22 9 L25 25 L28 17 H60";

export function HeartbeatLine({ reducedMotion }: HeartbeatLineProps) {
  return (
    <div
      className={reducedMotion ? "wake-heartbeat is-still" : "wake-heartbeat"}
      aria-hidden="true"
    >
      <svg viewBox="0 0 120 34" preserveAspectRatio="xMidYMid meet">
        <g className="wake-heartbeat-track">
          <path d={BEAT} />
          <path d={BEAT} transform="translate(60,0)" />
          <path d={BEAT} transform="translate(120,0)" />
        </g>
      </svg>
    </div>
  );
}
