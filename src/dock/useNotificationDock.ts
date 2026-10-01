import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  dockReducer,
  initialDockState,
  type DockAckAction,
  type DockNotification,
  type DockPhase,
} from "./dockMachine";

/**
 * useNotificationDock — owns the dock state machine and its timers.
 *
 * The dock's Nila is a single static lean-in frame (see App) — calm,
 * exactly like the reference, with no looping motion. The hook plays
 * no character sequences; on hide it returns the engine to idle so the
 * tray state stays clean.
 *
 * Phase choreography (full motion):
 * - entering (300ms): the chat card slides in from behind the top bar.
 * - expanding (400ms): card settles; Nila leans on its left edge.
 * - visible: the bubble holds for 15s, then auto-hides. Nila keeps
 *   leaning on the card — no pose changes, no extra chrome.
 * - acknowledging: a short beat, then the card collapses away.
 * - collapsing (260ms): dock contracts away; then the next queued
 *   notification enters (or the dock hides and Nila returns to idle).
 *
 * Reduced motion shortens every beat.
 */

const TIMING = {
  full: {
    entering: 300,
    expanding: 400,
    autoHide: 15000,
    ack: 450,
    collapsing: 260,
  },
  reduced: {
    entering: 120,
    expanding: 120,
    autoHide: 15000,
    ack: 200,
    collapsing: 120,
  },
} as const;

export interface NotificationDockApi {
  phase: DockPhase;
  current: DockNotification | null;
  queueLength: number;
  /** The action being acknowledged (set during acknowledging/collapsing). */
  ackAction: DockAckAction | null;
  notify: (n: DockNotification) => void;
  dismiss: (action: DockAckAction) => void;
  interact: () => void;
  disengage: () => void;
  forceHide: () => void;
}

export function useNotificationDock(opts: {
  playSequence: (name: string) => void;
  reducedMotion: boolean;
}): NotificationDockApi {
  const { playSequence, reducedMotion } = opts;
  const [state, dispatch] = useReducer(dockReducer, initialDockState());
  const timers = useRef<number[]>([]);
  const playRef = useRef(playSequence);
  playRef.current = playSequence;
  const phaseRef = useRef<DockPhase>("hidden");

  const clearTimers = useCallback(() => {
    for (const id of timers.current) window.clearTimeout(id);
    timers.current = [];
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  const notify = useCallback(
    (n: DockNotification) => dispatch({ type: "notify", notification: n }),
    [],
  );
  const dismiss = useCallback(
    (action: DockAckAction) => dispatch({ type: "dismiss", action }),
    [],
  );
  const interact = useCallback(() => dispatch({ type: "interact" }), []);
  const disengage = useCallback(() => dispatch({ type: "disengage" }), []);
  const forceHide = useCallback(() => dispatch({ type: "force-hide" }), []);

  useEffect(() => {
    const t = TIMING[reducedMotion ? "reduced" : "full"];
    const prev = phaseRef.current;
    phaseRef.current = state.phase;
    if (state.phase === prev) return;
    // A new phase cancels the previous phase's pending beats so a
    // quick dismiss can never be overruled by a stale timer.
    clearTimers();
    const later = (ms: number, fn: () => void) => {
      timers.current.push(window.setTimeout(fn, ms));
    };
    switch (state.phase) {
      case "entering":
        // The card slides/fades in via CSS. Nila is a static lean-in
        // frame — no sequence playback, so there is nothing to stutter.
        later(t.entering, () => dispatch({ type: "enter-done" }));
        break;
      case "expanding":
        later(t.expanding, () => dispatch({ type: "expand-done" }));
        break;
      case "visible":
        // The chat bubble auto-hides after 15s. Hovering (interacting)
        // clears this timer; leaving restarts it.
        later(t.autoHide, () => dispatch({ type: "dismiss", action: "dismissed" }));
        break;
      case "acknowledging":
        // No gesture swap: Nila keeps leaning on the card while it
        // collapses away. Minimal and powerful.
        later(t.ack, () => dispatch({ type: "ack-done" }));
        break;
      case "collapsing":
        later(t.collapsing, () => dispatch({ type: "collapse-done" }));
        break;
      case "hidden":
        playRef.current("idle");
        break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase, state.ackAction, reducedMotion]);

  return {
    phase: state.phase,
    current: state.current,
    queueLength: state.queue.length,
    ackAction: state.ackAction,
    notify,
    dismiss,
    interact,
    disengage,
    forceHide,
  };
}
