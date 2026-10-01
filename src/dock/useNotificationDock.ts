import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  dockReducer,
  initialDockState,
  type DockAckAction,
  type DockNotification,
  type DockPhase,
} from "./dockMachine";
import {
  expressionSlotForContext,
  type ExpressionSlot,
} from "./expressionSlots";

/**
 * useNotificationDock — owns the dock state machine and its timers.
 *
 * The dock's Nila is a square expression portrait in a small white box
 * (per reminder kind, several showing her front hands). DockNilaFigure
 * gives her gentle life — idle breathe, blink beats, crossfades, and
 * one-shot reactions — all transform/opacity only, no looping excess.
 * The hook plays no character sequences; on hide it returns the engine
 * to idle so the tray state stays clean.
 *
 * Phase choreography (full motion):
 * - entering (300ms): the chat card slides in from behind the top bar.
 * - expanding (400ms): card settles; Nila leans on its left edge.
 * - visible: the bubble holds for 15s, then auto-hides. Nila keeps
 *   leaning on the card — no pose changes, no extra chrome.
 * - acknowledging: a short beat, then the card collapses away. Done and
 *   snooze keep her current expression and play a single subtle blink
 *   before closing (~450ms); a dismissal holds ~1s on Nila's reaction
 *   (sad, or annoyed after a streak of dismissals) before collapsing.
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
    /** Dismissal holds on Nila's sad/annoyed reaction before collapsing. */
    react: 1000,
    collapsing: 260,
  },
  reduced: {
    entering: 120,
    expanding: 120,
    autoHide: 15000,
    ack: 200,
    react: 500,
    collapsing: 120,
  },
} as const;

export interface NotificationDockApi {
  phase: DockPhase;
  current: DockNotification | null;
  queueLength: number;
  /** The action being acknowledged (set during acknowledging/collapsing). */
  ackAction: DockAckAction | null;
  /**
   * Nila's acknowledgement reaction, set while a dismissal is being
   * acknowledged: sad on a rejection (or annoyed after a streak of
   * rejections). Null otherwise — done and snooze keep the per-kind
   * expression and answer with a single subtle blink instead.
   */
  reaction: ExpressionSlot | null;
  /**
   * Incremented each time done/snooze is acknowledged; DockNilaFigure
   * plays one immediate blink beat per increment, then the card closes.
   */
  blinkSignal: number;
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
  /** Back-to-back dismissals this session; done/snooze reset it. */
  const dismissStreak = useRef(0);
  const [reaction, setReaction] = useState<ExpressionSlot | null>(null);
  /** Bumped on every done/snooze ack to trigger one blink beat. */
  const [blinkSignal, setBlinkSignal] = useState(0);

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
        // The card slides/fades in via CSS; Nila's own entrance pop and
        // idle life are handled by DockNilaFigure + CSS — no sequence
        // playback, so there is nothing to stutter.
        setReaction(null);
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
        if (state.ackAction === "dismissed") {
          // Negative user action: Nila reacts briefly — sad, or a mild
          // annoyed huff after a streak of dismissals. Cute, never
          // guilt-tripping. The reaction holds ~1s, then collapses.
          dismissStreak.current += 1;
          setReaction(
            expressionSlotForContext({
              type: "rejected",
              consecutiveRejections: dismissStreak.current,
            }),
          );
          later(t.react, () => dispatch({ type: "ack-done" }));
        } else {
          // Done or snooze: no expression swap — she keeps her current
          // face, gives one subtle blink, and the card closes. Resets
          // the rejection streak.
          dismissStreak.current = 0;
          setReaction(null);
          setBlinkSignal((s) => s + 1);
          later(t.ack, () => dispatch({ type: "ack-done" }));
        }
        break;
      case "collapsing":
        later(t.collapsing, () => dispatch({ type: "collapse-done" }));
        break;
      case "hidden":
        setReaction(null);
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
    reaction,
    blinkSignal,
    notify,
    dismiss,
    interact,
    disengage,
    forceHide,
  };
}
