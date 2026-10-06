import { useEffect, useRef, useState } from "react";
import {
  useCursorDirection,
  cellBackgroundPosition,
} from "./useCursorDirection";

export interface NilaMascotProps {
  /** URL of the 3x3 directions sprite sheet. */
  directions: string;
  /** URL of the 3x3 reactions sprite sheet. */
  reactions: string;
  /** Pixel size (square). Default 140. */
  size?: number;
  /** Screen-reader label. Default "Nila". */
  label?: string;
  /** Optional class for positioning. */
  className?: string;
  /**
   * Force a specific reaction cell (0-8) instead of cursor tracking,
   * e.g. for contextual expressions. `null`/undefined resumes tracking.
   */
  reaction?: number | null;
  /** Called when the mascot is clicked/poked. */
  onPoke?: () => void;
}

const REACTION_MS = 500;

/**
 * Nila as a cursor-tracking mascot (page-mascot pattern).
 *
 * Her head follows the pointer using the directions sprite sheet;
 * clicking her flashes a cell from the reactions sheet, then she
 * resumes watching. Sprite swaps are pure background-position —
 * no animation library, no per-frame JS beyond the mousemove handler.
 */
export function NilaMascot({
  directions,
  reactions,
  size = 140,
  label = "Nila",
  className,
  reaction = null,
  onPoke,
}: NilaMascotProps) {
  const ref = useRef<HTMLDivElement>(null);
  const tracked = useCursorDirection(ref);
  const [pokeCell, setPokeCell] = useState<number | null>(null);
  const timer = useRef(0);

  // Click: flash a reaction, then go back to tracking.
  const poke = () => {
    // Cycle reactions so repeated pokes feel alive; dizzy (7) every 4th.
    setPokeCell((prev) => (prev === null ? 0 : (prev + 1) % 9));
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setPokeCell(null), REACTION_MS);
    onPoke?.();
  };

  useEffect(() => () => window.clearTimeout(timer.current), []);

  // Forced contextual reaction wins; else poke flash; else cursor tracking.
  const active =
    reaction !== null && reaction !== undefined
      ? { sheet: reactions, cell: reaction }
      : pokeCell !== null
        ? { sheet: reactions, cell: pokeCell }
        : { sheet: directions, cell: tracked };

  return (
    <div
      ref={ref}
      role="img"
      aria-label={label}
      className={className}
      onClick={poke}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          poke();
        }
      }}
      tabIndex={0}
      style={{
        width: size,
        height: size,
        backgroundImage: `url("${active.sheet}")`,
        backgroundSize: "300% 300%",
        backgroundPosition: cellBackgroundPosition(active.cell),
        backgroundRepeat: "no-repeat",
        cursor: "pointer",
        // Keep the sprite crisp; no layout shift on cell change.
        flex: "none",
      }}
    />
  );
}
