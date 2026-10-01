/**
 * Voice-command event contract between the Rust worker
 * (`src-tauri/src/voice.rs`) and the UI.
 *
 * The backend emits these while a post-wake voice session runs; the
 * future Jev layer consumes `voice:transcript_final`'s
 * `{ type: "voice_command", text }` payload. Partial transcripts are UI
 * only and must never reach Jev.
 *
 * `voice:response` is reserved for the future Jev layer and is NOT
 * emitted by the backend in V1 (no fabricated responses). The UI
 * tolerates it if it ever arrives.
 *
 * `voice:ended` marks the session fully torn down (mic handed back to
 * the wake-word listener); the UI hides the voice surface on it.
 */

import type { Dict } from "./i18n";

export const VOICE_EVENTS = {
  started: "voice:started",
  partial: "voice:transcript_partial",
  final: "voice:transcript_final",
  processing: "voice:processing",
  response: "voice:response",
  error: "voice:error",
  ended: "voice:ended",
} as const;

export type VoiceEventName = (typeof VOICE_EVENTS)[keyof typeof VOICE_EVENTS];

/** UI-side phase of a voice session. Mirrors the backend state machine. */
export type VoicePhase = "idle" | "listening" | "recording" | "processing" | "error";

/** Error codes the backend reports with `voice:error`. */
export type VoiceErrorCode =
  | "speech_timeout"
  | "empty_transcript"
  | "mic_error"
  | "model_error";

export interface VoiceStartedPayload {
  type: "voice:started";
}

export interface VoicePartialPayload {
  type: "voice:transcript_partial";
  text: string;
}

export interface VoiceFinalPayload {
  type: "voice_command";
  text: string;
}

export interface VoiceProcessingPayload {
  type: "voice:processing";
}

export interface VoiceErrorPayload {
  type: "voice:error";
  code: VoiceErrorCode;
  message: string;
}

export interface VoiceEndedPayload {
  type: "voice:ended";
}

/**
 * Localized user-facing line for a voice error code. The backend's
 * `message` is a debug string; the UI shows this instead.
 */
export function voiceErrorLabel(code: VoiceErrorCode, voice: Dict["voice"]): string {
  switch (code) {
    case "speech_timeout":
      return voice.speechTimeout;
    case "empty_transcript":
      return voice.emptyTranscript;
    case "mic_error":
      return voice.micError;
    case "model_error":
      return voice.modelError;
  }
}
