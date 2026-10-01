// CharacterEngine — the state machine and animation controller for
// Nila's companion character. Original design; kept separate from the
// scheduler so states/animations can evolve independently.
//
// States (V1): idle, happy, sleeping, thinking, worried, excited,
// waving, reminding, sad, paused, hidden.
//
// Momentary expression faces (character/expressions/) overlay the current
// state via showExpression/clearExpression; see expressions.ts.

import type { ExpressionName } from "./expressions.ts";
import { MOTION_SEQUENCES } from "./motionManifest.ts";

export type CharacterState =
  | "idle"
  | "happy"
  | "sleeping"
  | "thinking"
  | "worried"
  | "excited"
  | "waving"
  | "reminding"
  | "sad"
  | "paused"
  | "hidden";

export type CharacterAnimation =
  | "idle-breathe"
  | "idle-blink"
  | "happy-bounce"
  | "thinking"
  | "wave"
  | "attention"
  | "wake"
  | "remind"
  | "dismiss"
  | "snooze"
  | "sleep"
  | "sad";

export type CharacterSize = "small" | "medium" | "large";
export type MotionPreference = "full" | "reduced" | "off";

/**
 * One animation frame from the generated motion-asset library
 * (character/motion/). The renderer resolves `key` to a bundled URL via
 * motionAssets.frameUrl(); per-frame timing (`ms`) drives the playback
 * hook. `sequence` groups frames so the renderer crossfades only on
 * sequence/state changes, never between consecutive movement frames.
 */
export interface MotionFrame {
  sequence: string;
  key: string;
  index: number;
  total: number;
  ms: number;
}

export interface CharacterSnapshot {
  state: CharacterState;
  animation: CharacterAnimation | null;
  size: CharacterSize;
  visible: boolean;
  motion: MotionPreference;
  /** Momentary expression face overlaying the state image, if any. */
  expression: ExpressionName | null;
  /** Currently displayed motion frame, if a frame sequence is active. */
  frame: MotionFrame | null;
  /** Active sequence name ("flash" for one-shot overrides), else null. */
  sequence: string | null;
  idleBehavior: "normal" | "minimal";
}

type Listener = (snapshot: CharacterSnapshot) => void;
type SequenceEndListener = (name: string) => void;

// Which animations are legal to interrupt (all except none — every
// animation can be interrupted so the character never gets stuck).
const REMINDER_SEQUENCE: CharacterState[] = ["reminding"];

/** Legal follow-ups per state, used to catch stuck transitions. */
const ALLOWED_TRANSITIONS: Record<CharacterState, CharacterState[]> = {
  idle: ["happy", "sleeping", "thinking", "worried", "excited", "waving", "reminding", "sad", "paused", "hidden"],
  happy: ["idle", "waving", "excited", "reminding", "hidden", "paused"],
  sleeping: ["idle", "reminding", "paused", "hidden"],
  thinking: ["idle", "reminding", "happy", "hidden", "paused"],
  worried: ["idle", "reminding", "happy", "hidden", "paused"],
  excited: ["idle", "happy", "hidden", "paused"],
  waving: ["idle", "happy", "hidden", "paused"],
  reminding: ["idle", "happy", "waving", "sleeping", "sad", "hidden", "paused"],
  sad: ["idle", "happy", "hidden", "paused"],
  paused: ["idle", "sleeping", "hidden"],
  hidden: ["idle", "sleeping", "paused"],
};

export class CharacterEngine {
  private state: CharacterState = "idle";
  private animation: CharacterAnimation | null = "idle-breathe";
  private size: CharacterSize = "small";
  private motion: MotionPreference = "full";
  private idleBehavior: "normal" | "minimal" = "normal";
  private expression: ExpressionName | null = null;
  private listeners = new Set<Listener>();
  private resumeState: CharacterState = "idle";
  // --- Frame-sequence playback (generated motion assets) ---
  private seqName: string | null = null;
  private seqIndex = 0;
  private seqDir: 1 | -1 = 1;
  private chain: string[] = [];
  /** One-shot frame override (blink); the underlying sequence resumes after. */
  private flashKey: string | null = null;
  private seqEndListeners = new Set<SequenceEndListener>();
  private seqEndFired = false;

  constructor() {
    // She is already idling when the engine is born.
    if (this.motion === "full" && this.idleBehavior === "normal") {
      this.seqName = "idle";
    }
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): CharacterSnapshot {
    return {
      state: this.state,
      animation: this.motion === "off" ? null : this.animation,
      size: this.size,
      visible: this.state !== "hidden",
      motion: this.motion,
      expression: this.expression,
      frame: this.currentFrame(),
      sequence: this.flashKey ? "flash" : this.seqName,
      idleBehavior: this.idleBehavior,
    };
  }

  private currentFrame(): MotionFrame | null {
    // Frame sequences are a full-motion feature. Under reduced motion
    // Nila holds a static pose (the legacy state image); "off" shows
    // nothing framed either (spec 23).
    if (this.motion !== "full") return null;
    if (this.flashKey) {
      return { sequence: "flash", key: this.flashKey, index: 0, total: 1, ms: 160 };
    }
    if (!this.seqName) return null;
    const def = MOTION_SEQUENCES[this.seqName];
    if (!def) return null;
    const idx = Math.min(this.seqIndex, def.frames.length - 1);
    const f = def.frames[idx];
    return { sequence: this.seqName, key: f.key, index: idx, total: def.frames.length, ms: f.ms };
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const l of this.listeners) l(snap);
  }

  /** Transition to a state; throws on illegal transitions so stuck states surface in tests. */
  setState(next: CharacterState): void {
    if (next === this.state) return;
    // A state change retires any running frame sequence first; the
    // specific flows below start their own. Silent — the emit below
    // covers the cleared frame too.
    this.clearSequence();
    // Sleep is the universal rest state: pause() may enter it from anywhere.
    if (next !== "sleeping") {
      const allowed = ALLOWED_TRANSITIONS[this.state];
      if (!allowed.includes(next)) {
        throw new Error(`Illegal character transition: ${this.state} -> ${next}`);
      }
    }
    this.state = next;
    this.animation = this.defaultAnimationFor(next);
    this.emit();
    this.autoplayIdle();
  }

  /** Idle state breathes via the idle frame loop (full motion only). */
  private autoplayIdle(): void {
    if (
      this.state === "idle" &&
      this.motion === "full" &&
      this.idleBehavior === "normal"
    ) {
      this.playSequence("idle");
    }
  }

  private defaultAnimationFor(state: CharacterState): CharacterAnimation | null {
    if (this.motion === "off") return null;
    switch (state) {
      case "idle":
        if (this.idleBehavior === "minimal") return null;
        return this.motion === "reduced" ? null : "idle-breathe";
      case "happy": return this.motion === "reduced" ? null : "happy-bounce";
      case "sleeping": return "sleep";
      case "thinking": return "thinking";
      case "waving": return "wave";
      case "reminding": return "remind";
      case "sad": return "sad";
      case "paused": return "sleep";
      case "hidden": return null;
      default: return null;
    }
  }

  playAnimation(name: CharacterAnimation): void {
    if (this.motion === "off") return;
    // Reduced motion: swap bouncy/attention animations for fades (null = instant).
    if (this.motion === "reduced" && (name === "happy-bounce" || name === "attention" || name === "idle-breathe")) {
      return;
    }
    this.animation = name;
    this.emit();
  }

  interruptAnimation(): void {
    this.animation = this.defaultAnimationFor(this.state);
    this.emit();
  }

  /**
   * Show a momentary expression face over the current state image.
   * The caller owns timing (see flashExpression in App.tsx); the engine
   * never clears it on its own so beats can't be cut short by a state
   * change underneath.
   */
  showExpression(name: ExpressionName): void {
    this.expression = name;
    this.emit();
  }

  /** Clear the expression, revealing the underlying state image again. */
  clearExpression(): void {
    if (this.expression === null) return;
    this.expression = null;
    this.emit();
  }

  returnToIdle(): void {
    if (this.state === "paused") {
      this.resumeState = "idle";
      return; // paused persists until resume()
    }
    this.setState(this.state === "hidden" ? "hidden" : "idle");
  }

  setSize(size: CharacterSize): void {
    this.size = size;
    this.emit();
  }

  setMotion(motion: MotionPreference): void {
    this.motion = motion;
    this.stopSequence();
    this.animation = this.defaultAnimationFor(this.state);
    this.emit();
    this.autoplayIdle();
  }

  /** Minimal idle behavior: Nila stays still while waiting. */
  setIdleBehavior(behavior: "normal" | "minimal"): void {
    this.idleBehavior = behavior;
    this.stopSequence();
    this.animation = this.defaultAnimationFor(this.state);
    this.emit();
    this.autoplayIdle();
  }

  // --- Frame-sequence player (generated motion assets) ---
  //
  // The engine owns *which* sequence plays; a React hook
  // (useFramePlayback) owns the per-frame timers and calls
  // advanceFrame(). Frame sequences are a full-motion feature: under
  // reduced/off motion the calls below are no-ops and Nila holds the
  // legacy static pose (spec 23).

  /**
   * Start a named sequence from motionManifest. Unknown names are
   * ignored (never break the character); non-full motion disables
   * frames entirely.
   */
  playSequence(name: string): void {
    const def = MOTION_SEQUENCES[name];
    if (!def) {
      console.warn(`[nila] unknown motion sequence: ${name}`);
      return;
    }
    if (this.motion !== "full") return;
    this.flashKey = null;
    this.chain = [];
    this.seqName = name;
    this.seqIndex = 0;
    this.seqDir = 1;
    this.seqEndFired = false;
    this.emit();
  }

  /** Play several sequences back-to-back; onSequenceEnd fires per sequence. */
  playChain(names: string[]): void {
    const known = names.filter((n) => MOTION_SEQUENCES[n]);
    if (known.length === 0 || this.motion !== "full") {
      this.stopSequence();
      return;
    }
    const [first, ...rest] = known;
    this.flashKey = null;
    this.chain = rest;
    this.seqName = first;
    this.seqIndex = 0;
    this.seqDir = 1;
    this.seqEndFired = false;
    this.emit();
  }

  /** Stop frame playback, revealing the legacy state image again. */
  stopSequence(): void {
    if (!this.seqName && !this.flashKey && this.chain.length === 0) return;
    this.clearSequence();
    this.emit();
  }

  /** Reset sequence fields without emitting (for callers that emit next). */
  private clearSequence(): void {
    this.seqName = null;
    this.seqIndex = 0;
    this.seqDir = 1;
    this.chain = [];
    this.flashKey = null;
    this.seqEndFired = false;
  }

  /**
   * Advance one frame. Called by the playback hook on each frame's
   * timer; when a non-looping sequence finishes, the next chained
   * sequence starts (or the frames clear) and onSequenceEnd fires.
   */
  advanceFrame(): void {
    if (this.flashKey) return; // a flash freezes the underlying sequence
    if (!this.seqName || this.motion !== "full") return;
    const def = MOTION_SEQUENCES[this.seqName];
    if (!def) {
      this.seqName = null;
      this.emit();
      return;
    }
    const total = def.frames.length;
    if (def.loop === "loop") {
      this.seqIndex = (this.seqIndex + 1) % total;
      this.emit();
      return;
    }
    if (def.loop === "pingpong") {
      if (this.seqDir === 1) {
        if (this.seqIndex >= total - 1) this.seqDir = -1;
        else this.seqIndex++;
      }
      if (this.seqDir === -1) {
        if (this.seqIndex <= 0) {
          this.endCurrentSequence();
          return;
        }
        this.seqIndex--;
      }
      this.emit();
      return;
    }
    // loop === "none": play once, then chain / hold / clear.
    if (this.seqIndex >= total - 1) {
      this.endCurrentSequence();
      return;
    }
    this.seqIndex++;
    this.emit();
  }

  private endCurrentSequence(): void {
    const finished = this.seqName;
    if (!finished) return;
    const def = MOTION_SEQUENCES[finished];
    const next = this.chain.shift();
    if (next) {
      this.seqEndFired = false;
      this.seqName = next;
      this.seqIndex = 0;
      this.seqDir = 1;
      this.emit();
      for (const l of this.seqEndListeners) l(finished);
      return;
    }
    if (def?.holdLast) {
      // Hold the landing frame (peek idle, reminder settle): the
      // snapshot keeps showing it until something else plays. The end
      // event fires exactly once even if advanceFrame is called again;
      // nothing is emitted when the frame is unchanged.
      this.seqIndex = def.frames.length - 1;
      if (!this.seqEndFired) {
        this.seqEndFired = true;
        this.emit();
        for (const l of this.seqEndListeners) l(finished);
      }
      return;
    }
    this.seqEndFired = false;
    this.seqName = null;
    this.seqIndex = 0;
    this.seqDir = 1;
    this.emit();
    for (const l of this.seqEndListeners) l(finished);
  }

  /** One-shot frame override (blink). The sequence resumes on clearFlash. */
  flashFrame(key: string): void {
    if (this.motion !== "full") return;
    if (this.flashKey === key) return;
    this.flashKey = key;
    this.emit();
  }

  /** Clear the one-shot override, revealing the sequence underneath. */
  clearFlash(): void {
    if (!this.flashKey) return;
    this.flashKey = null;
    this.emit();
  }

  /**
   * Fired once per finished non-looping sequence (also for holdLast
   * sequences when they land). Callers chain the reminder arc on this.
   */
  onSequenceEnd(listener: SequenceEndListener): () => void {
    this.seqEndListeners.add(listener);
    return () => {
      this.seqEndListeners.delete(listener);
    };
  }

  // --- Reminder-experience sequences (spec section 36) ---

  /**
   * idle -> reminding. Single meaningful transition. The reminder-enter
   * frame sequence (notice -> look -> enter -> settle) plays on the
   * reminding state; the caller chains point -> wait on sequence end and
   * shows the bubble ~130ms after the settle lands.
   */
  beginReminder(_kind: "water" | "food" | "break" | "move" | "sleep" | "custom"): void {
    this.setState("reminding");
    if (this.motion !== "off") this.playAnimation("attention");
    this.playSequence("reminder-enter");
  }

  /**
   * Dismiss: the bubble is already gone (caller hides it first). She
   * reacts, then retreats. A completed task earns a thumbs-up; a plain
   * dismiss gets the happy react + goodbye beat.
   */
  dismissReminder(completed = false): void {
    this.setState("happy");
    if (this.motion !== "off") this.playAnimation("wave");
    this.playChain(
      completed
        ? ["thumbsup", "reminder-retreat"]
        : ["reminder-react", "reminder-retreat"],
    );
  }

  /**
   * Snooze: an understanding look, then she retreats; the caller
   * (exitAfterBeat + dismissCompanion) hides the window after the beat.
   */
  snoozeReminder(): void {
    this.setState("sleeping");
    if (this.motion !== "off") this.playAnimation("snooze");
    this.playChain(["snooze-ack", "reminder-retreat"]);
  }

  /** Pause from any state: sleep -> paused, with the sleep frame loop. */
  pause(): void {
    this.resumeState = this.state === "hidden" ? "idle" : this.state;
    this.setState("sleeping");
    this.setState("paused");
    this.playSequence("sleep");
  }

  resume(): void {
    if (this.state !== "paused") return;
    // Resume restores whatever state was paused — bypasses the normal
    // transition table by design (spec: pause from *any* state).
    const target = this.resumeState === "paused" ? "idle" : this.resumeState;
    this.state = target;
    this.animation = this.defaultAnimationFor(target);
    this.emit();
    this.autoplayIdle();
  }

  /** Greeting / onboarding: the wave frame sequence, out and back once. */
  wave(): void {
    this.setState("waving");
    this.playAnimation("wave");
    this.playSequence("wave");
  }

  /** Test helper: is this state part of an active reminder flow? */
  isReminding(): boolean {
    return REMINDER_SEQUENCE.includes(this.state);
  }
}
