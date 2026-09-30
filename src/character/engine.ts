// CharacterEngine — the state machine and animation controller for
// Nila's companion character. Original design; kept separate from the
// scheduler so states/animations can evolve independently.
//
// States (V1): idle, happy, sleeping, thinking, worried, excited,
// waving, reminding, sad, paused, celebrating, hidden.
//
// Momentary expression faces (character/expressions/) overlay the current
// state via showExpression/clearExpression; see expressions.ts.

import type { ExpressionName } from "./expressions";

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
  | "celebrating"
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
  | "celebrate"
  | "sad";

export type CharacterSize = "small" | "medium" | "large";
export type MotionPreference = "full" | "reduced" | "off";

export interface CharacterSnapshot {
  state: CharacterState;
  animation: CharacterAnimation | null;
  size: CharacterSize;
  visible: boolean;
  motion: MotionPreference;
  /** Momentary expression face overlaying the state image, if any. */
  expression: ExpressionName | null;
}

type Listener = (snapshot: CharacterSnapshot) => void;

// Which animations are legal to interrupt (all except none — every
// animation can be interrupted so the character never gets stuck).
const REMINDER_SEQUENCE: CharacterState[] = ["reminding"];

/** Legal follow-ups per state, used to catch stuck transitions. */
const ALLOWED_TRANSITIONS: Record<CharacterState, CharacterState[]> = {
  idle: ["happy", "sleeping", "thinking", "worried", "excited", "waving", "reminding", "sad", "paused", "celebrating", "hidden"],
  happy: ["idle", "waving", "excited", "reminding", "hidden", "paused"],
  sleeping: ["idle", "reminding", "paused", "hidden"],
  thinking: ["idle", "reminding", "happy", "hidden", "paused"],
  worried: ["idle", "reminding", "happy", "hidden", "paused"],
  excited: ["idle", "happy", "celebrating", "hidden", "paused"],
  waving: ["idle", "happy", "hidden", "paused"],
  reminding: ["idle", "happy", "waving", "sleeping", "sad", "hidden", "paused"],
  sad: ["idle", "happy", "hidden", "paused"],
  paused: ["idle", "sleeping", "hidden"],
  celebrating: ["idle", "happy", "hidden", "paused"],
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
    };
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const l of this.listeners) l(snap);
  }

  /** Transition to a state; throws on illegal transitions so stuck states surface in tests. */
  setState(next: CharacterState): void {
    if (next === this.state) return;
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
      case "celebrating": return "celebrate";
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
    this.animation = this.defaultAnimationFor(this.state);
    this.emit();
  }

  /** Minimal idle behavior: Nila stays still while waiting. */
  setIdleBehavior(behavior: "normal" | "minimal"): void {
    this.idleBehavior = behavior;
    this.animation = this.defaultAnimationFor(this.state);
    this.emit();
  }

  // --- Reminder-experience sequences (spec section 36) ---

  /** idle -> attention -> reminding */
  beginReminder(kind: "water" | "food" | "break" | "move" | "sleep" | "custom"): void {
    if (kind === "custom") {
      this.setState("thinking");
    } else if (kind === "sleep") {
      this.setState("sleeping");
    }
    if (this.motion !== "off") this.playAnimation("attention");
    this.setState("reminding");
  }

  /** Dismiss: happy/wave -> idle */
  dismissReminder(): void {
    this.playAnimation("dismiss");
    this.setState("happy");
    this.playAnimation("wave");
    this.setState("idle");
  }

  /** Snooze: sleepy -> sleep -> hidden */
  snoozeReminder(): void {
    this.setState("sleeping");
    this.playAnimation("snooze");
    this.setState("hidden");
  }

  /** Pause from any state: sleep -> paused */
  pause(): void {
    this.resumeState = this.state === "hidden" ? "idle" : this.state;
    this.setState("sleeping");
    this.setState("paused");
  }

  resume(): void {
    if (this.state !== "paused") return;
    // Resume restores whatever state was paused — bypasses the normal
    // transition table by design (spec: pause from *any* state).
    const target = this.resumeState === "paused" ? "idle" : this.resumeState;
    this.state = target;
    this.animation = this.defaultAnimationFor(target);
    this.emit();
  }

  /** Greeting / onboarding. */
  wave(): void {
    this.setState("waving");
    this.playAnimation("wave");
  }

  /** Test helper: is this state part of an active reminder flow? */
  isReminding(): boolean {
    return REMINDER_SEQUENCE.includes(this.state);
  }
}
