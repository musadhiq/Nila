import { useEffect, useRef, useState } from "react";

/**
 * Tracks the cursor and returns which of the 9 sprite cells the mascot
 * should show. Cell layout (3x3):
 *
 *   0: up-left    1: up    2: up-right
 *   3: left       4: center 5: right
 *   6: down-left  7: down  8: down-right
 *
 * She looks toward the mouse only while it moves; when the mouse goes
 * idle she settles back to center (looking directly at you). Returns 4
 * when the device has no fine pointer or reduced motion is preferred.
 */
export function useCursorDirection(
  targetRef: React.RefObject<HTMLElement | null>,
  deadZonePx = 40,
  idleMs = 1200,
): number {
  const [cell, setCell] = useState(4);
  const rafRef = useRef(0);
  const idleRef = useRef(0);
  const lastCell = useRef(4);

  useEffect(() => {
    // No tracking without a fine pointer, or under reduced motion.
    if (
      typeof window === "undefined" ||
      !window.matchMedia("(pointer: fine)").matches ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }

    const lookCenter = () => {
      if (lastCell.current !== 4) {
        lastCell.current = 4;
        setCell(4);
      }
    };

    const onMove = (e: MouseEvent) => {
      cancelAnimationFrame(rafRef.current);
      // Mouse moved: cancel the idle timer, she stays attentive.
      window.clearTimeout(idleRef.current);
      rafRef.current = requestAnimationFrame(() => {
        const el = targetRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const dx = e.clientX - cx;
        const dy = e.clientY - cy;

        let next = 4;
        if (Math.hypot(dx, dy) >= deadZonePx) {
          const angle = Math.atan2(dy, dx); // -PI..PI, 0 = right
          const sector = Math.round(angle / (Math.PI / 4));
          const map: Record<number, number> = {
            0: 5, // right
            1: 8, // down-right
            2: 7, // down
            3: 6, // down-left
            4: 3, // left
            "-3": 0, // up-left
            "-2": 1, // up
            "-1": 2, // up-right
          };
          next = map[sector] ?? 4;
        }

        if (next !== lastCell.current) {
          lastCell.current = next;
          setCell(next);
        }
      });
      // Mouse stopped: after idleMs she looks back at you.
      idleRef.current = window.setTimeout(lookCenter, idleMs);
    };

    window.addEventListener("mousemove", onMove, { passive: true });
    return () => {
      window.removeEventListener("mousemove", onMove);
      cancelAnimationFrame(rafRef.current);
      window.clearTimeout(idleRef.current);
    };
  }, [targetRef, deadZonePx, idleMs]);

  return cell;
}

/** Convert a 0-8 cell index to a background-position for a 3x3 sprite. */
export function cellBackgroundPosition(cell: number): string {
  const row = Math.floor(cell / 3);
  const col = cell % 3;
  return `${col * 50}% ${row * 50}%`;
}
