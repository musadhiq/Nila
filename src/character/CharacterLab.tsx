// CharacterLab — dev-only asset gallery (spec 24).
//
// Rendered only in DEV builds when ?nila-debug (or localStorage
// "nila.debug") is set. It previews every motion sequence at actual
// app size with Play/Pause/Restart and 0.5x/1x/1.5x/2x speed, plus a
// thumbnail strip of every frame. It drives its own local playback
// (mirroring the engine's loop semantics) so the app engine is never
// disturbed while inspecting assets.

import { useEffect, useMemo, useState } from "react";
import { MOTION_SEQUENCES, type MotionSequenceName } from "./motionManifest";
import { frameUrl } from "./motionAssets";

const SPEEDS = [0.5, 1, 1.5, 2] as const;
/** Preview stage at the real medium character size. */
const STAGE_PX = 160;

function totalMs(name: MotionSequenceName): number {
  return MOTION_SEQUENCES[name].frames.reduce((a, f) => a + f.ms, 0);
}

function nextIndex(
  name: MotionSequenceName,
  index: number,
  dir: 1 | -1,
): { index: number; dir: 1 | -1; done: boolean } {
  const def = MOTION_SEQUENCES[name];
  const total = def.frames.length;
  if (def.loop === "loop") return { index: (index + 1) % total, dir, done: false };
  if (def.loop === "pingpong") {
    if (dir === 1) {
      if (index >= total - 1) return { index: index - 1, dir: -1, done: false };
      return { index: index + 1, dir: 1, done: false };
    }
    if (index <= 0) return { index: 0, dir: 1, done: true };
    return { index: index - 1, dir: -1, done: false };
  }
  // loop === "none"
  if (index >= total - 1) return { index, dir, done: true };
  return { index: index + 1, dir, done: false };
}

function FrameThumb({ frameKey, px }: { frameKey: string; px: number }) {
  const src = frameUrl(frameKey);
  if (!src) {
    return (
      <span
        title={`missing: ${frameKey}`}
        style={{
          width: px,
          height: px,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          background: "rgba(255,80,80,0.15)",
          border: "1px dashed #c33",
          borderRadius: 4,
          fontSize: 9,
          color: "#c33",
          overflow: "hidden",
        }}
      >
        ?
      </span>
    );
  }
  return (
    <img
      src={src}
      alt={frameKey}
      title={frameKey}
      draggable={false}
      style={{
        width: px,
        height: px,
        objectFit: "contain",
        background: "rgba(127,127,127,0.12)",
        borderRadius: 4,
      }}
    />
  );
}

export function CharacterLab({ onClose }: { onClose: () => void }) {
  const names = useMemo(
    () => Object.keys(MOTION_SEQUENCES) as MotionSequenceName[],
    [],
  );
  const [selected, setSelected] = useState<MotionSequenceName>("idle");
  const [index, setIndex] = useState(0);
  const [dir, setDir] = useState<1 | -1>(1);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState<number>(1);

  const def = MOTION_SEQUENCES[selected];
  const frame = def.frames[Math.min(index, def.frames.length - 1)];

  // Reset when switching sequences.
  useEffect(() => {
    setIndex(0);
    setDir(1);
    setPlaying(true);
  }, [selected]);

  // Local playback timer (mirrors engine.advanceFrame semantics).
  useEffect(() => {
    if (!playing) return;
    const ms = Math.max(30, frame.ms / speed);
    const t = window.setTimeout(() => {
      const n = nextIndex(selected, index, dir);
      setIndex(n.index);
      setDir(n.dir);
      if (n.done) setPlaying(false);
    }, ms);
    return () => window.clearTimeout(t);
  }, [playing, selected, index, dir, speed, frame.ms]);

  const src = frameUrl(frame.key);

  return (
    <div className="char-lab" role="dialog" aria-label="Character Lab (dev only)">
      <div className="char-lab-head">
        <strong>Character Lab</strong>
        <span className="char-lab-sub">dev only · {STAGE_PX}px stage · actual app size</span>
        <button type="button" className="char-lab-close" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="char-lab-body">
        <div className="char-lab-list" role="listbox" aria-label="Sequences">
          {names.map((n) => {
            const d = MOTION_SEQUENCES[n];
            return (
              <button
                key={n}
                type="button"
                role="option"
                aria-selected={n === selected}
                className={`char-lab-seq${n === selected ? " active" : ""}`}
                onClick={() => setSelected(n)}
              >
                <span className="char-lab-seq-name">{n}</span>
                <span className="char-lab-seq-meta">
                  {d.frames.length}f · {(totalMs(n) / 1000).toFixed(1)}s · {d.loop}
                  {d.holdLast ? " · hold" : ""}
                </span>
              </button>
            );
          })}
        </div>
        <div className="char-lab-preview">
          <div
            className="char-lab-stage"
            style={{ width: STAGE_PX, height: STAGE_PX }}
          >
            {src ? (
              <img
                src={src}
                alt={`${selected} frame ${index + 1}`}
                draggable={false}
                style={{
                  maxWidth: "100%",
                  maxHeight: "100%",
                  objectFit: "contain",
                }}
              />
            ) : (
              <span className="char-lab-missing">missing: {frame.key}</span>
            )}
          </div>
          <div className="char-lab-controls">
            <button type="button" onClick={() => setPlaying((p) => !p)}>
              {playing ? "Pause" : "Play"}
            </button>
            <button
              type="button"
              onClick={() => {
                setIndex(0);
                setDir(1);
                setPlaying(true);
              }}
            >
              Restart
            </button>
            <span className="char-lab-speeds" role="group" aria-label="Speed">
              {SPEEDS.map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={speed === s}
                  className={speed === s ? "active" : ""}
                  onClick={() => setSpeed(s)}
                >
                  {s}×
                </button>
              ))}
            </span>
          </div>
          <div className="char-lab-frameinfo">
            {selected} · frame {index + 1}/{def.frames.length} · {frame.ms}ms
            {speed !== 1 ? ` @ ${speed}×` : ""} · anchor{" "}
            {def.anchor ? `${def.anchor.x}/${def.anchor.y}` : "-"}
            <br />
            <code>{frame.key}</code>
          </div>
          <div className="char-lab-strip">
            {def.frames.map((f, i) => (
              <button
                key={f.key}
                type="button"
                className={`char-lab-thumb${i === index ? " active" : ""}`}
                onClick={() => {
                  setIndex(i);
                  setPlaying(false);
                }}
                title={`${f.key} · ${f.ms}ms`}
              >
                <FrameThumb frameKey={f.key} px={44} />
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
