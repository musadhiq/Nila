/**
 * Notification positioning API.
 *
 * V1 implements exactly one position: TOP_CENTER — a notification dock
 * directly below the camera/notch area (or a small safe margin from the
 * top edge when there is none). The enum and the rect helper are shaped
 * so future positions (TOP_LEFT, BOTTOM_CENTER, corners, ...) slot in
 * without changing call sites.
 */

export const NotificationPosition = {
  TOP_CENTER: "top-center",
  // Future: TOP_LEFT: "top-left", TOP_RIGHT: "top-right",
  // BOTTOM_CENTER: "bottom-center", LEFT: "left", RIGHT: "right", ...
} as const;

export type NotificationPosition =
  (typeof NotificationPosition)[keyof typeof NotificationPosition];

export interface PxRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Top-left origin (physical pixels) for a window of `winW` x `winH`
 * placed at `position` on `monitor`. `safeMargin` is the gap below the
 * top edge (camera/notch area) in physical pixels.
 */
export function dockWindowOrigin(
  position: NotificationPosition,
  monitor: PxRect,
  winW: number,
  winH: number,
  safeMargin: number,
): { x: number; y: number } {
  switch (position) {
    case NotificationPosition.TOP_CENTER: {
      // Center horizontally; clamp so the window never leaves the monitor
      // on very narrow displays.
      const x = Math.round(monitor.x + (monitor.width - winW) / 2);
      const clampedX = Math.max(monitor.x, Math.min(x, monitor.x + monitor.width - winW));
      return { x: clampedX, y: Math.round(monitor.y + safeMargin) };
    }
    default: {
      // Unknown future position: fall back to top-center, never throw.
      const x = Math.round(monitor.x + (monitor.width - winW) / 2);
      void winH;
      return {
        x: Math.max(monitor.x, Math.min(x, monitor.x + monitor.width - winW)),
        y: Math.round(monitor.y + safeMargin),
      };
    }
  }
}
