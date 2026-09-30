import type { CharacterAnimation, CharacterSize, CharacterState } from "./engine";

/**
 * NilaCharacter — original vector artwork for Nila's companion.
 *
 * A soft moon-drop: rounded crescent-tinted body, expressive eyes, small
 * blush marks. Drawn entirely in code (no image assets) so it stays crisp
 * from 32px to 256px and adapts to light/dark themes.
 *
 * Do not imitate any existing product's mascot.
 */

interface Props {
  state: CharacterState;
  animation: CharacterAnimation | null;
  size: CharacterSize;
  dark?: boolean;
}

const SIZE_PX: Record<CharacterSize, number> = { small: 64, medium: 128, large: 192 };

function eyesFor(state: CharacterState): "open" | "happy" | "closed" | "worried" | "sleepy" | "starry" {
  switch (state) {
    case "happy":
    case "celebrating":
    case "excited":
      return "happy";
    case "sleeping":
    case "paused":
      return "closed";
    case "worried":
    case "sad":
      return "worried";
    case "thinking":
      return "sleepy";
    case "reminding":
      return "starry";
    default:
      return "open";
  }
}

function mouthFor(state: CharacterState): "smile" | "small" | "flat" | "open" | "none" {
  switch (state) {
    case "happy":
    case "excited":
    case "celebrating":
    case "waving":
      return "smile";
    case "sad":
    case "worried":
      return "flat";
    case "reminding":
      return "open";
    case "sleeping":
    case "paused":
      return "none";
    default:
      return "small";
  }
}

export function NilaCharacter({ state, animation, size, dark = false }: Props) {
  const px = SIZE_PX[size];
  const eyes = eyesFor(state);
  const mouth = mouthFor(state);

  const body = dark ? "#3b4a6b" : "#e8eefc";
  const shade = dark ? "#2c3852" : "#cfdbf5";
  const glow = dark ? "#8fa8ff" : "#6f8ff7";
  const ink = dark ? "#f2f5ff" : "#2b3350";
  const blush = dark ? "#7d6a8a" : "#f4b8c1";

  const animClass =
    animation === "happy-bounce" ? "nila-bounce"
    : animation === "wave" ? "nila-wave"
    : animation === "idle-breathe" ? "nila-breathe"
    : animation === "attention" ? "nila-attention"
    : animation === "sleep" ? "nila-sleepy"
    : "";

  return (
    <svg
      width={px}
      height={px}
      viewBox="0 0 100 100"
      role="img"
      aria-label={state === "hidden" ? "നില മറഞ്ഞിരിക്കുന്നു" : "നില"}
      className={animClass}
    >
      {/* body: soft moon-drop */}
      <path
        d="M50 8 C74 8 90 30 90 54 C90 78 72 94 50 94 C28 94 10 78 10 54 C10 30 26 8 50 8 Z"
        fill={body}
        stroke={shade}
        strokeWidth="2.5"
      />
      {/* crescent highlight */}
      <path
        d="M30 26 C36 18 48 14 58 18 C48 20 40 28 38 40 C30 38 26 32 30 26 Z"
        fill={glow}
        opacity="0.55"
      />
      {/* blush */}
      <ellipse cx="30" cy="62" rx="6" ry="4" fill={blush} opacity="0.7" />
      <ellipse cx="70" cy="62" rx="6" ry="4" fill={blush} opacity="0.7" />

      {/* eyes */}
      {eyes === "open" && (
        <g fill={ink}>
          <ellipse cx="38" cy="50" rx="5" ry="7" />
          <ellipse cx="62" cy="50" rx="5" ry="7" />
          <circle cx="40" cy="48" r="1.8" fill="#fff" />
          <circle cx="64" cy="48" r="1.8" fill="#fff" />
        </g>
      )}
      {eyes === "happy" && (
        <g stroke={ink} strokeWidth="3" strokeLinecap="round" fill="none">
          <path d="M32 52 Q38 44 44 52" />
          <path d="M56 52 Q62 44 68 52" />
        </g>
      )}
      {eyes === "closed" && (
        <g stroke={ink} strokeWidth="3" strokeLinecap="round">
          <line x1="32" y1="52" x2="44" y2="52" />
          <line x1="56" y1="52" x2="68" y2="52" />
        </g>
      )}
      {eyes === "worried" && (
        <g fill={ink}>
          <ellipse cx="38" cy="52" rx="5" ry="6" />
          <ellipse cx="62" cy="52" rx="5" ry="6" />
        </g>
      )}
      {eyes === "sleepy" && (
        <g fill={ink}>
          <ellipse cx="38" cy="52" rx="5" ry="3.5" />
          <ellipse cx="62" cy="48" rx="5" ry="7" />
        </g>
      )}
      {eyes === "starry" && (
        <g fill={ink}>
          <path d="M38 44 l2.2 4.6 4.6 2.2 -4.6 2.2 -2.2 4.6 -2.2 -4.6 -4.6 -2.2 4.6 -2.2 Z" />
          <ellipse cx="62" cy="50" rx="5" ry="7" />
          <circle cx="64" cy="48" r="1.8" fill="#fff" />
        </g>
      )}

      {/* mouth */}
      {mouth === "smile" && (
        <path d="M42 68 Q50 76 58 68" stroke={ink} strokeWidth="3" strokeLinecap="round" fill="none" />
      )}
      {mouth === "small" && (
        <path d="M46 69 Q50 72 54 69" stroke={ink} strokeWidth="2.5" strokeLinecap="round" fill="none" />
      )}
      {mouth === "flat" && (
        <line x1="44" y1="70" x2="56" y2="70" stroke={ink} strokeWidth="2.5" strokeLinecap="round" />
      )}
      {mouth === "open" && (
        <ellipse cx="50" cy="70" rx="5" ry="6.5" fill={ink} />
      )}

      {/* sleep "z"s */}
      {(state === "sleeping" || state === "paused") && (
        <g fill={glow} fontSize="12" fontWeight="bold">
          <text x="78" y="22">z</text>
          <text x="86" y="12" fontSize="9">z</text>
        </g>
      )}
    </svg>
  );
}
