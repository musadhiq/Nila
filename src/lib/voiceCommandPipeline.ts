/**
 * VoiceCommandPipeline — the integration layer between STT and Jev.
 *
 * ```text
 * STT                        PIPELINE                  JEV (Rust service)
 *  │                            │                            │
 *  │ voice:transcript_partial   │                            │
 *  │ (live, UI only ────────────┤  NEVER forwarded           │
 *  │  never reaches Jev)        │                            │
 *  │                            │                            │
 *  │ voice:transcript_final     │                            │
 *  │ ──────────────────────────▶│ validate + clean           │
 *  │                            │ check Jev reachable        │──▶ process_voice_command
 *  │                            │                            │     (worker thread,
 *  │                            │◀──── jev:processing ───────│      never blocks UI)
 *  │                            │         (PROCESSING)       │
 *  │                            │◀─── jev:action_detected ───│
 *  │                            │         (EXECUTING)        │
 *  │                            │◀─────── jev:result ────────│──▶ existing executor
 *  │                            │         (RESPONSE)         │     (allowlisted, no shell)
 *  │                            │◀─────── jev:error ─────────│
 *  │                            │     (RESPONSE = error)     │
 * ```
 *
 * What this module does NOT do (by design):
 * - It never sees partial transcripts (the host only calls
 *   `handleFinalTranscript` from the `voice:transcript_final` listener).
 * - It never talks to the Jev API directly — `processVoiceCommand`
 *   (the existing JevService Tauri command) owns parsing, the secure
 *   token, and the network. No duplication.
 * - It never executes actions — the Rust `ActionExecutor` does that,
 *   after schema validation, on a worker thread.
 * - It never renders UI itself — the host (App) owns the existing
 *   voice pill; the pipeline only drives it through `PipelineHost`.
 *
 * Logical phases (the existing pill renders processing/executing/
 * response all with its "Working on it…" look — the UI is unchanged):
 *   PROCESSING → final transcript received, sent to Jev
 *   EXECUTING  → Jev returned an actionable intent
 *   RESPONSE   → Nila's answer (or error) is being presented
 */

import {
  jevGetStatus,
  jevResponse,
  processVoiceCommand,
  type JevError,
  type JevResultPayload,
  type JevStatus,
} from "./jev.ts";
import type { Dict } from "./i18n";

export type PipelinePhase = "idle" | "processing" | "executing" | "response";

export type PipelineDecision =
  | { kind: "forwarded" }
  /** Nothing to send (STT already emitted its own empty-transcript error). */
  | { kind: "empty" }
  /** A command is already in flight — the new transcript is dropped, never duplicated. */
  | { kind: "busy" }
  /** The Jev service couldn't be reached; an error was shown. */
  | { kind: "unavailable" };

/** The Jev bridge the pipeline talks to. Injectable for tests. */
export interface PipelineDeps {
  getStatus(): Promise<JevStatus>;
  sendToJev(text: string): Promise<void>;
}

/**
 * What the pipeline asks its host to do. The host owns the existing
 * voice UI and the Tauri event subscriptions; the pipeline owns the
 * STT→Jev decision logic.
 */
export interface PipelineHost {
  /** Render a pipeline phase through the existing voice UI. */
  render(phase: PipelinePhase, text: string): void;
  /** Nila's answer is ready: present it, then return to idle. */
  answer(message: string): void;
  /** Current localized strings. */
  strings(): Dict;
}

/** Give up waiting for Jev rather than holding the pill forever. */
const SAFETY_TIMEOUT_MS = 30_000;

const defaultDeps: PipelineDeps = {
  getStatus: jevGetStatus,
  sendToJev: processVoiceCommand,
};

export class VoiceCommandPipeline {
  private phase: PipelinePhase = "idle";
  private displayText = "";
  private safetyTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly host: PipelineHost;
  private readonly deps: PipelineDeps;

  constructor(host: PipelineHost, deps: PipelineDeps = defaultDeps) {
    this.host = host;
    this.deps = deps;
  }

  get currentPhase(): PipelinePhase {
    return this.phase;
  }

  /** True while a Jev command owns the voice surface. */
  isActive(): boolean {
    return this.phase !== "idle";
  }

  /**
   * `voice:transcript_final` — the ONLY STT output Jev ever sees.
   * Call this exclusively from the final-transcript listener; partials
   * must never reach it.
   *
   * One command at a time: if a command is already in flight, the new
   * transcript is dropped (`busy`), never queued or duplicated. The
   * in-flight command always terminates (result, error, or the safety
   * timer), so the gate can't stick.
   */
  async handleFinalTranscript(rawText: string): Promise<PipelineDecision> {
    const text = rawText.trim();
    if (!text) {
      // STT emits voice:error/empty_transcript for this itself — there
      // is nothing to forward and nothing to show twice.
      return { kind: "empty" };
    }
    if (this.isActive()) {
      return { kind: "busy" };
    }
    // Configuration/health gate. Token policy (hybrid local parsing vs
    // api-only, the rate-limited missing-token notice) lives in the
    // Rust Jev service — this only verifies the service answers.
    try {
      await this.deps.getStatus();
    } catch {
      this.fail("jevInternalError");
      return { kind: "unavailable" };
    }
    this.setPhase("processing", text);
    this.armSafetyTimer();
    try {
      // Fire-and-forget: the Rust command spawns a worker thread and
      // returns immediately. The outcome arrives as jev:* events.
      await this.deps.sendToJev(text);
    } catch {
      this.fail("jevInternalError");
      return { kind: "unavailable" };
    }
    return { kind: "forwarded" };
  }

  /** `jev:processing` — the Rust service picked up the transcript. */
  handleJevProcessing(): void {
    // Already in PROCESSING since the final arrived; this just
    // confirms the handoff. Stale events (no active command) are ignored.
    if (this.phase === "processing") this.host.render("processing", this.displayText);
  }

  /** `jev:action_detected` — Jev returned an actionable intent. */
  handleActionDetected(_intent: string): void {
    if (this.isActive()) this.setPhase("executing");
  }

  /**
   * `jev:result` — the existing executor finished. `intent` may be
   * `unknown`: that still lands here as Nila's normal "I don't know
   * how to do that yet" response, via the response layer.
   */
  handleResult(payload: JevResultPayload): void {
    if (!this.isActive()) return;
    const message = jevResponse(
      payload.response_key,
      payload.response_params,
      this.host.strings(),
    );
    this.finish(message);
  }

  /** `jev:error` — token / network / timeout / bad response. Never crashes. */
  handleError(payload: JevError): void {
    if (!this.isActive()) return;
    const message = jevResponse(payload.response_key, undefined, this.host.strings());
    this.finish(message);
  }

  /** `voice:error` — the STT session died; abandon any pending command. */
  handleVoiceError(): void {
    this.reset();
  }

  /** Release timers (effect cleanup). */
  dispose(): void {
    this.clearSafetyTimer();
  }

  // -- internals ----------------------------------------------------------

  private setPhase(phase: PipelinePhase, text?: string): void {
    this.phase = phase;
    if (text !== undefined) this.displayText = text;
    this.host.render(phase, this.displayText);
  }

  private finish(message: string): void {
    this.clearSafetyTimer();
    this.setPhase("response", message);
    this.host.answer(message);
    // The answer is terminal: the host presents it, then dismisses.
    this.phase = "idle";
    this.displayText = "";
  }

  private fail(responseKey: string): void {
    const message = jevResponse(responseKey, undefined, this.host.strings());
    this.finish(message);
  }

  private reset(): void {
    this.clearSafetyTimer();
    this.phase = "idle";
    this.displayText = "";
  }

  private armSafetyTimer(): void {
    this.clearSafetyTimer();
    this.safetyTimer = setTimeout(() => {
      this.safetyTimer = null;
      if (this.isActive()) this.fail("jevInternalError");
    }, SAFETY_TIMEOUT_MS);
  }

  private clearSafetyTimer(): void {
    if (this.safetyTimer !== null) {
      clearTimeout(this.safetyTimer);
      this.safetyTimer = null;
    }
  }
}
