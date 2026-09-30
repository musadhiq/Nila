import type { CharacterAnimation, CharacterSize, CharacterState } from "./engine";
// Character art lives in the repo's character/ folder (single source of
// truth); Vite bundles these imports into dist/assets at build time.
import idleImg from "../../character/idle.png";
import happyImg from "../../character/happy.png";
import sleepingImg from "../../character/sleeping.png";
import thinkingImg from "../../character/thinking.png";
import worriedImg from "../../character/worried.png";
import excitedImg from "../../character/excited.png";
import wavingImg from "../../character/waving.png";
import remindingImg from "../../character/reminding.png";
import sadImg from "../../character/sad.png";
import pausedImg from "../../character/paused.png";
import celebratingImg from "../../character/celebrating.png";

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

const MALAYALAM_LABEL: Record<CharacterState, string> = {
  idle: "നില",
  happy: "സന്തോഷവതിയായ നില",
  sleeping: "ഉറങ്ങുന്ന നില",
  thinking: "ആലോചിക്കുന്ന നില",
  worried: "ആശങ്കയിലായ നില",
  excited: "ആവേശത്തിലായ നില",
  waving: "കൈ വീശുന്ന നില",
  reminding: "ഓർമ്മിപ്പിക്കുന്ന നില",
  sad: "ദുഃഖിതയായ നില",
  paused: "നിർത്തിവെച്ച നില",
  celebrating: "ആഘോഷിക്കുന്ന നില",
  hidden: "നില മറഞ്ഞിരിക്കുന്നു",
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

export function NilaCharacter({ state, animation, size, dark = false }: Props) {
  const src = imageForState(state);
  if (!src) return null;
  const px = SIZE_PX[size];
  return (
    <img
      src={src}
      width={px}
      height={px}
      alt={MALAYALAM_LABEL[state]}
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
