/**
 * Notification dock state machine — pure logic, no React.
 *
 * The dock is Nila's V1 notification surface: a single top-center card.
 * Exactly one notification is ever on screen; the rest wait in a FIFO
 * queue. Explicit phases prevent animation race conditions:
 *
 *   hidden -> entering -> expanding -> visible -> acknowledging
 *                                             \-> interacting -/
 *   acknowledging -> collapsing -> hidden (-> entering, when queued)
 *
 * Rules:
 * - `notify` while hidden starts the enter sequence immediately.
 * - `notify` while anything is on screen enqueues (never restarts the
 *   current animation from zero).
 * - `dismiss` is honored from entering/expanding/visible/interacting and
 *   moves to acknowledging (the exit animation always completes before
 *   the next notification shows).
 * - `collapse-done` dequeues the next notification, if any.
 * - Events that make no sense in the current phase are ignored.
 */

export type DockPhase =
  | "hidden"
  | "entering"
  | "expanding"
  | "visible"
  | "interacting"
  | "acknowledging"
  | "collapsing";

export type DockAckAction = "completed" | "dismissed" | "snoozed";

export interface DockNotification {
  id: string;
  title: string;
  message: string;
  kind: string;
}

export type DockEvent =
  | { type: "notify"; notification: DockNotification }
  | { type: "enter-done" }
  | { type: "expand-done" }
  | { type: "interact" }
  | { type: "disengage" }
  | { type: "dismiss"; action: DockAckAction }
  | { type: "ack-done" }
  | { type: "collapse-done" }
  | { type: "force-hide" };

export interface DockState {
  phase: DockPhase;
  current: DockNotification | null;
  queue: DockNotification[];
  ackAction: DockAckAction | null;
}

export function initialDockState(): DockState {
  return { phase: "hidden", current: null, queue: [], ackAction: null };
}

/** Replace an already-queued/current notification with the same id. */
function upsert(queue: DockNotification[], n: DockNotification): DockNotification[] {
  const i = queue.findIndex((q) => q.id === n.id);
  if (i < 0) return [...queue, n];
  return queue.map((q, j) => (j === i ? n : q));
}

export function dockReducer(state: DockState, event: DockEvent): DockState {
  switch (event.type) {
    case "notify": {
      const n = event.notification;
      // A repeat of the on-screen notification just refreshes it.
      if (state.current && state.current.id === n.id && state.phase !== "hidden") {
        return { ...state, current: n };
      }
      if (state.phase === "hidden") {
        return { phase: "entering", current: n, queue: [], ackAction: null };
      }
      // Something is on screen (or leaving): queue, never restart.
      return { ...state, queue: upsert(state.queue, n) };
    }
    case "enter-done":
      return state.phase === "entering" ? { ...state, phase: "expanding" } : state;
    case "expand-done":
      return state.phase === "expanding" ? { ...state, phase: "visible" } : state;
    case "interact":
      return state.phase === "visible" ? { ...state, phase: "interacting" } : state;
    case "disengage":
      return state.phase === "interacting" ? { ...state, phase: "visible" } : state;
    case "dismiss": {
      if (
        state.phase === "visible" ||
        state.phase === "interacting" ||
        state.phase === "entering" ||
        state.phase === "expanding"
      ) {
        return { ...state, phase: "acknowledging", ackAction: event.action };
      }
      return state;
    }
    case "ack-done":
      return state.phase === "acknowledging" ? { ...state, phase: "collapsing" } : state;
    case "collapse-done": {
      if (state.phase !== "collapsing") return state;
      const [next, ...rest] = state.queue;
      if (next) {
        return { phase: "entering", current: next, queue: rest, ackAction: null };
      }
      return { phase: "hidden", current: null, queue: [], ackAction: null };
    }
    case "force-hide":
      return initialDockState();
    default:
      return state;
  }
}

/** Phases in which the dock card is on screen (window must stay visible). */
export function isDockOnScreen(phase: DockPhase): boolean {
  return phase !== "hidden";
}
