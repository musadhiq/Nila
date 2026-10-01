import { useEffect, useState } from "react";
import type { CharacterAnimation, CharacterSize, CharacterState, MotionFrame } from "./engine";
import { EXPRESSION_LABEL, type ExpressionName } from "./expressions";
import { MOTION_SEQUENCES, type FrameAnchor } from "./motionManifest";
// Character art lives in the repo's character/ folder (single source of
// truth); Vite bundles these imports into dist/assets at build time.
// States in character/states/, momentary faces in character/expressions/.
// All PNGs are transparent-background cutouts.
import idleImg from "../../character/states/idle.png";
import happyImg from "../../character/states/happy.png";
import sleepingImg from "../../character/states/sleeping.png";
import thinkingImg from "../../character/states/thinking.png";
import worriedImg from "../../character/states/worried.png";
import excitedImg from "../../character/states/excited.png";
import wavingImg from "../../character/states/waving.png";
import remindingImg from "../../character/states/reminding.png";
import sadImg from "../../character/states/sad.png";
import pausedImg from "../../character/states/paused.png";
import celebratingImg from "../../character/states/celebrating.png";
// Momentary expression faces from the concept sheet (character/expressions/).
import surprisedImg from "../../character/expressions/surprised.png";
import sleepyImg from "../../character/expressions/sleepy.png";
import proudImg from "../../character/expressions/proud.png";
import curiousImg from "../../character/expressions/curious.png";
import playfulImg from "../../character/expressions/playful.png";
import confusedImg from "../../character/expressions/confused.png";
import facepalmImg from "../../character/expressions/facepalm.png";
import ideaImg from "../../character/expressions/idea.png";
import pointImg from "../../character/expressions/point.png";
import thumbsUpImg from "../../character/expressions/thumbs-up.png";
import explainImg from "../../character/expressions/explain.png";
import restChinImg from "../../character/expressions/rest-chin.png";

/**
 * NilaCharacter — Nila's companion character, rendered from the
 * project character set (see character/): a young South Indian girl
 * with long wavy black hair, red bindi, gold jhumkas, light green kurta.
 *
 * One transparent PNG per engine state; CSS handles the motion. The
 * `hidden` state renders nothing — visibility is driven by the engine.
 *
 * Two variants:
 * - "cutout" (default): the full transparent character, floating on the
 *   desktop with an alpha-aware drop shadow. This is the desktop-companion
 *   look — no circular crop.
 * - "avatar": a circular cropped portrait for compact UI (settings lists,
 *   etc.). The desktop companion never uses this.
 *
 * The optional ground shadow is a soft ellipse under bottom-standing
 * positions. It is a static, non-animating element (it stays planted
 * while Nila breathes/bounces), and callers should only enable it when
 * Nila is anchored to the bottom edge — never for side peeks or when
 * hanging from the top.
 */

interface Props {
  state: CharacterState;
  animation: CharacterAnimation | null;
  size: CharacterSize;
  dark?: boolean;
  /** Momentary expression face; takes precedence over the state image. */
  expression?: ExpressionName | null;
  /** "cutout" (desktop companion) or "avatar" (circular portrait). */
  variant?: "cutout" | "avatar";
  /** Soft elliptical ground shadow under the character. Only meaningful
   *  with variant="cutout" at a bottom-anchored position. */
  groundShadow?: boolean;
  /** Active motion frame from the engine (generated asset library). When
   *  set, it wins over the legacy state image. */
  frame?: MotionFrame | null;
  /** Bundled URL for `frame` (resolved via motionAssets.frameUrl). */
  frameSrc?: string | null;
  /** Dev-only debug overlay (state/sequence/frame/anchor). Rendered only
   *  in DEV builds. */
  debug?: boolean;
  /** Position label for the debug overlay (e.g. "bottom-right"). */
  debugPosition?: string | null;
}

const SIZE_PX: Record<CharacterSize, number> = { small: 96, medium: 160, large: 224 };

const IMAGE_FOR_STATE: Record<Exclude<CharacterState, "hidden">, string> = {
  idle: idleImg,
  happy: happyImg,
  sleeping: sleepingImg,
  thinking: thinkingImg,
  worried: worriedImg,
  excited: excitedImg,
  waving: wavingImg,
  reminding: remindingImg,
  sad: sadImg,
  paused: pausedImg,
  celebrating: celebratingImg,
};

/** Exported for tests and for preloading. */
export function imageForState(state: CharacterState): string | null {
  if (state === "hidden") return null;
  return IMAGE_FOR_STATE[state];
}

/** Expression PNGs, keyed by ExpressionName. Kept here (not in
 *  expressions.ts) so node --test can import that module without a PNG
 *  loader; Vite bundles these at build time. */
const EXPRESSION_IMAGES: Record<ExpressionName, string> = {
  surprised: surprisedImg,
  sleepy: sleepyImg,
  proud: proudImg,
  curious: curiousImg,
  playful: playfulImg,
  confused: confusedImg,
  facepalm: facepalmImg,
  idea: ideaImg,
  point: pointImg,
  "thumbs-up": thumbsUpImg,
  explain: explainImg,
  "rest-chin": restChinImg,
};

const STATE_LABEL: Record<CharacterState, string> = {
  idle: "Nila",
  happy: "Happy Nila",
  sleeping: "Sleeping Nila",
  thinking: "Thinking Nila",
  worried: "Worried Nila",
  excited: "Excited Nila",
  waving: "Waving Nila",
  reminding: "Nila reminding you",
  sad: "Sad Nila",
  paused: "Paused Nila",
  celebrating: "Celebrating Nila",
  hidden: "Nila is hidden",
};

function animClass(animation: CharacterAnimation | null): string {
  switch (animation) {
    case "happy-bounce": return "nila-bounce";
    case "wave": return "nila-wave";
    case "idle-breathe": return "nila-breathe";
    case "attention": return "nila-attention";
    case "sleep":
    case "snooze": return "nila-sleepy";
    default: return "";
  }
}

/** Dev-only flag: the debug overlay never ships in production builds. */
function isDevBuild(): boolean {
  try {
    const meta = import.meta as unknown as { env?: { DEV?: boolean } };
    return !!meta.env?.DEV;
  } catch {
    return false;
  }
}

const FLEX_FOR_X: Record<FrameAnchor["x"], string> = {
  left: "flex-start",
  center: "center",
  right: "flex-end",
};
const FLEX_FOR_Y: Record<FrameAnchor["y"], string> = {
  top: "flex-start",
  center: "center",
  bottom: "flex-end",
};

interface XLayer {
  id: number;
  src: string;
  fadeKey: string;
}

/**
 * Crossfade stack: consecutive frames of one sequence swap directly
 * (same fadeKey), while sequence/state/expression changes fade over
 * ~160ms. Only the newest two layers are ever mounted.
 */
function useCrossfade(src: string | null, fadeKey: string): { layers: XLayer[]; entered: boolean } {
  const [layers, setLayers] = useState<XLayer[]>(() =>
    src ? [{ id: 0, src, fadeKey }] : [],
  );
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    if (!src) {
      setLayers([]);
      return;
    }
    let changed = false;
    setLayers((prev) => {
      const top = prev[prev.length - 1];
      if (top && top.fadeKey === fadeKey) {
        if (top.src === src) return prev;
        changed = true;
        return [...prev.slice(0, -1), { ...top, src }];
      }
      changed = true;
      const next: XLayer = { id: (top?.id ?? -1) + 1, src, fadeKey };
      return [...prev, next].slice(-2);
    });
    if (changed) setEntered(false);
  }, [src, fadeKey]);

  useEffect(() => {
    if (layers.length < 2) {
      setEntered(true);
      return;
    }
    // Double rAF so the browser paints opacity 0 before transitioning.
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setEntered(true));
    });
    const t = window.setTimeout(() => setLayers((p) => p.slice(-1)), 240);
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      window.clearTimeout(t);
    };
  }, [layers]);

  return { layers, entered };
}

export function NilaCharacter({
  state,
  animation,
  size,
  dark = false,
  expression = null,
  variant = "cutout",
  groundShadow = false,
  frame = null,
  frameSrc = null,
  debug = false,
  debugPosition = null,
}: Props) {
  const px = SIZE_PX[size];

  // Frame mode wins over the legacy state image (but never over an
  // explicit expression overlay).
  const useFrame = !expression && frame !== null && frameSrc !== null;
  const src = expression
    ? EXPRESSION_IMAGES[expression]
    : useFrame
      ? frameSrc
      : imageForState(state);
  const avatarSrc = expression ? EXPRESSION_IMAGES[expression] : imageForState(state);

  // Crossfade group: consecutive frames of one sequence share a group
  // (direct swap, no flicker); sequence/state/expression changes fade.
  // NOTE: this hook must run before any early return so the hook order
  // stays stable across renders.
  const fadeKey = expression
    ? `expr:${expression}`
    : useFrame
      ? `seq:${frame!.sequence}`
      : `state:${state}`;
  const { layers, entered } = useCrossfade(src, fadeKey);

  const label = expression
    ? EXPRESSION_LABEL[expression]
    : useFrame
      ? `Nila ${frame!.sequence} frame ${frame!.index + 1}`
      : STATE_LABEL[state];

  if (variant === "avatar") {
    if (!avatarSrc) return null;
    return (
      <img
        src={avatarSrc}
        width={px}
        height={px}
        alt={label}
        role="img"
        className={animClass(animation)}
        draggable={false}
        style={{
          borderRadius: "50%",
          objectFit: "cover",
          filter: dark ? "brightness(0.94)" : undefined,
          pointerEvents: "none",
        }}
      />
    );
  }
  if (!src) return null;

  // Drop shadow is alpha-aware so she lifts off the wallpaper.
  const dropShadow = dark
    ? "drop-shadow(0 10px 18px rgba(0, 0, 0, 0.5)) brightness(0.94)"
    : "drop-shadow(0 10px 18px rgba(0, 0, 0, 0.35))";

  const showDebug = debug && isDevBuild();
  const anchor: FrameAnchor = useFrame
    ? (MOTION_SEQUENCES[frame.sequence]?.anchor ?? { x: "center", y: "bottom" })
    : { x: "center", y: "bottom" };

  const renderLayerImg = (layerSrc: string) =>
    useFrame ? (
      <img
        src={layerSrc}
        alt={label}
        role="img"
        draggable={false}
        style={{
          // Natural size capped by the stage; the flex anchor positions
          // the frame (peeks hug their edge, hangs hang from the top).
          maxWidth: "100%",
          maxHeight: "100%",
          objectFit: "contain",
          display: "block",
          filter: dropShadow,
          pointerEvents: "none",
        }}
      />
    ) : (
      <img
        src={layerSrc}
        alt={label}
        role="img"
        className={animClass(animation)}
        draggable={false}
        style={{
          width: "100%",
          height: "auto",
          display: "block",
          filter: dropShadow,
          pointerEvents: "none",
        }}
      />
    );

  return (
    <span
      className={useFrame ? "nila-frame-stage" : "nila-cutout"}
      style={
        useFrame
          // Overflow stays visible so the alpha-aware drop-shadow on the img
          // can fade into the window's padding instead of being hard-clipped
          // at the stage edge (the companion window is larger than the stage).
          ? { width: px, height: px, position: "relative", display: "block", overflow: "visible" }
          : { width: px, position: "relative", display: "block" }
      }
    >
      {groundShadow && <span className="nila-ground-shadow" aria-hidden="true" />}
      {layers.map((layer, i) => {
        const isTop = i === layers.length - 1 && layers.length > 1;
        return (
          <span
            key={layer.id}
            aria-hidden={isTop ? undefined : true}
            style={
              useFrame
                ? {
                    position: "absolute",
                    inset: 0,
                    display: "flex",
                    alignItems: FLEX_FOR_Y[anchor.y],
                    justifyContent: FLEX_FOR_X[anchor.x],
                    opacity: isTop && !entered ? 0 : 1,
                    transition: "opacity 160ms ease",
                  }
                : isTop
                  ? {
                      position: "absolute",
                      inset: 0,
                      opacity: !entered ? 0 : 1,
                      transition: "opacity 160ms ease",
                    }
                  : { position: "relative", display: "block" }
            }
          >
            {renderLayerImg(layer.src)}
          </span>
        );
      })}
      {showDebug && (
        <span className="nila-debug">
          {`NILA DEBUG\nState: ${state}\nAnim: ${animation ?? "-"}\nSeq: ${frame?.sequence ?? "-"}\nFrame: ${frame ? `${frame.index + 1}/${frame.total}` : "-"}\nAsset: ${frame?.key ?? "-"}\nPos: ${debugPosition || "-"}\nAnchor: ${anchor.x}/${anchor.y}`}
        </span>
      )}
    </span>
  );
}
