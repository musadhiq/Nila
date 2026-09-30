import type { CharacterAnimation, CharacterSize, CharacterState } from "./engine";
import { EXPRESSION_LABEL, type ExpressionName } from "./expressions";
// Character art lives in the repo's character/ folder (single source of
// truth); Vite bundles these imports into dist/assets at build time.
// States in character/states/, momentary faces in character/expressions/.
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
 * One 1024px PNG per engine state; CSS handles the motion. The `hidden`
 * state renders nothing — visibility is driven by the engine.
 *
 * Note: current artwork has a light painted background. Transparent-
 * background variants are planned so the character floats cleanly on
 * dark wallpapers too.
 */

interface Props {
  state: CharacterState;
  animation: CharacterAnimation | null;
  size: CharacterSize;
  dark?: boolean;
  /** Momentary expression face; takes precedence over the state image. */
  expression?: ExpressionName | null;
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

export function NilaCharacter({ state, animation, size, dark = false, expression = null }: Props) {
  const src = expression ? EXPRESSION_IMAGES[expression] : imageForState(state);
  if (!src) return null;
  const px = SIZE_PX[size];
  return (
    <img
      src={src}
      width={px}
      height={px}
      alt={expression ? EXPRESSION_LABEL[expression] : STATE_LABEL[state]}
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
