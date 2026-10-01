import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  dockReducer,
  initialDockState,
  type DockAckAction,
  type DockNotification,
  type DockPhase,
} from "./dockMachine";

/**
 * useNotificationDock — owns the dock state machine, its timers, and
 * Nila's gesture choreography (via the character engine's playSequence).
 *
 * Phase choreography (full motion):
 * - entering (300ms): dock slides/fades in; Nila plays `reminder-enter`.
 * - expanding (400ms): card settles to full size.
 * - visible: Nila does the `reminder-point` attention gesture, then
 *   loops `reminder-wait` (with blinks) until the user acts.
 * - acknowledging: Done -> `thumbsup`; Snooze -> `snooze-ack`;
 *   Dismiss -> `reminder-react`.
 * - collapsing (260ms): dock contracts away; then the next queued
 *   notification enters (or the dock hides and Nila returns to idle).
 *
 * Reduced motion shortens every beat and the engine itself calms down.
 */

const TIMING = {
  full: {
    entering: 300,
    expanding: 400,
    pointHold: 800,
    ackCompleted: 1100,
    ackDismissed: 1600,
    ackSnoozed: 1200,
    collapsing: 260,
  },
  reduced: {
    entering: 120,
    expanding: 120,
    pointHold: 300,
    ackCompleted: 400,
    ackDismissed: 400,
    ackSnoozed: 400,
    collapsing: 120,
  },
} as const;

export interface NotificationDockApi {
  phase: DockPhase;
  current: DockNotification | null;
  queueLength: number;
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
        playRef.current("reminder-enter");
        later(t.entering, () => dispatch({ type: "enter-done" }));
        break;
      case "expanding":
        later(t.expanding, () => dispatch({ type: "expand-done" }));
        break;
      case "visible":
        playRef.current("reminder-point");
        later(t.pointHold, () => playRef.current("reminder-wait"));
        break;
      case "acknowledging": {
        const ack = state.ackAction;
        playRef.current(
          ack === "completed" ? "thumbsup" : ack === "snoozed" ? "snooze-ack" : "reminder-react",
        );
        const ms =
          ack === "completed" ? t.ackCompleted : ack === "snoozed" ? t.ackSnoozed : t.ackDismissed;
        later(ms, () => dispatch({ type: "ack-done" }));
        break;
      }
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
    notify,
    dismiss,
    interact,
    disengage,
    forceHide,
  };
}
