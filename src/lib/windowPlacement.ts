// Window placement: Nila's home position, the tray fly-in glide, and the
// math behind them.
//
// Pure helpers only — no Tauri imports — so node --test can cover them.
// App.tsx performs the actual window calls (monitors, setPosition, show).

export interface Xy {
  x: number;
  y: number;
}

export interface MonitorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const STORAGE_KEY = "nila.windowPos.v1";

/** Last home position, in physical pixels. Null when never saved. */
export function loadSavedPosition(): Xy | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<Xy>;
    if (typeof p.x === "number" && typeof p.y === "number") {
      return { x: p.x, y: p.y };
    }
  } catch {
    /* corrupted or unavailable storage */
  }
  return null;
}

/** Persist the home position (physical pixels). Best-effort. */
export function saveWindowPosition(x: number, y: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ x, y }));
  } catch {
    /* storage unavailable — position just won't persist */
  }
}

/**
 * Default home: bottom-right of the monitor with a small margin.
 * All values in physical pixels.
 */
export function homePosition(
  mon: MonitorRect,
  winW: number,
  winH: number,
  margin = 16,
): Xy {
  return {
    x: mon.x + mon.width - winW - margin,
    y: mon.y + mon.height - winH - margin,
  };
}

/**
 * Where the fly-in starts: top-right, just under the menu bar —
 * where the tray icon lives. All values in physical pixels.
 */
export function trayStartPosition(
  mon: MonitorRect,
  winW: number,
  margin = 12,
  topOffset = 36,
): Xy {
  return {
    x: mon.x + mon.width - winW - margin,
    y: mon.y + topOffset,
  };
}

/** True when the point sits on (or just near) any monitor. */
export function isOnAnyMonitor(p: Xy, mons: MonitorRect[], tolerance = 48): boolean {
  return mons.some(
    (m) =>
      p.x >= m.x - tolerance &&
      p.x <= m.x + m.width + tolerance &&
      p.y >= m.y - tolerance &&
      p.y <= m.y + m.height + tolerance,
  );
}

/**
 * Ease-out-cubic glide from `from` to `to`, calling setPos per frame.
 * Resolves when the glide finishes.
 */
export function glidePosition(
  from: Xy,
  to: Xy,
  durationMs: number,
  setPos: (x: number, y: number) => void,
): Promise<void> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const frame = (now: number) => {
      const t = Math.min(1, (now - t0) / durationMs);
      const e = 1 - Math.pow(1 - t, 3);
      setPos(
        Math.round(from.x + (to.x - from.x) * e),
        Math.round(from.y + (to.y - from.y) * e),
      );
      if (t < 1) requestAnimationFrame(frame);
      else resolve();
    };
    requestAnimationFrame(frame);
  });
}
