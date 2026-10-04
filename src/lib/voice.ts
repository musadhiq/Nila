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
import { invokeCommand } from "./tauri.ts";

export const VOICE_EVENTS = {
  started: "voice:started",
  partial: "voice:transcript_partial",
  final: "voice:transcript_final",
  processing: "voice:processing",
  response: "voice:response",
  error: "voice:error",
  repeat: "voice:repeat",
  ended: "voice:ended",
  /** Smoothed mic input level (0–1), ~16 Hz while the mic is captured. */
  level: "voice:level",
} as const;

/**
 * Model provisioning events, emitted by the Rust model downloader
 * (`src-tauri/src/models.rs`). The STT models are not bundled with the
 * app: the user downloads them once, manually, from Settings (~80 MB
 * into the app-data dir). `downloading` only fires while a manual
 * download is actually running; the settings section surfaces its
 * progress, and an active voice session's bubble does too.
 */
export const MODEL_EVENTS = {
  downloading: "nila://models-downloading",
  ready: "nila://models-ready",
  error: "nila://models-error",
} as const;

export interface ModelsDownloadingPayload {
  type: "nila://models-downloading";
  /** Which file is being fetched ("whisper-encoder.int8.onnx", "whisper-decoder.int8.onnx", "tokens.txt" or "silero_vad.onnx"). */
  file: string;
  downloaded_bytes: number;
  /** 0 when the server didn't report a length. */
  total_bytes: number;
}

export interface ModelsErrorPayload {
  type: "nila://models-error";
  message: string;
}

/** UI-side phase of a voice session. Mirrors the backend state machine. */
export type VoicePhase = "idle" | "listening" | "recording" | "processing" | "error";

/** Error codes the backend reports with `voice:error`. */
export type VoiceErrorCode =
  | "speech_timeout"
  | "empty_transcript"
  | "mic_error"
  | "model_error"
  | "models_missing";

export interface VoicePartialPayload {
  type: "voice:transcript_partial";
  text: string;
}

export interface VoiceFinalPayload {
  type: "voice_command";
  text: string;
}

export interface VoiceErrorPayload {
  type: "voice:error";
  code: VoiceErrorCode;
  message: string;
}

/**
 * Emitted when the transcript came back empty and Nila asks the user to
 * repeat. The session stays alive; the UI keeps the pill open and shows
 * the localized prompt until the retry's partials arrive.
 */
export interface VoiceRepeatPayload {
  type: "voice:repeat";
  attempt: number;
}

/**
 * Smoothed mic input level driving the listening wave animation.
 * Emitted ~16 Hz from the Rust capture loop while the mic is held
 * (waiting-for-speech and recording phases). `level` is 0 (silence)
 * to 1 (loud), fast-attack / slow-release smoothed.
 */
export interface VoiceLevelPayload {
  type: "voice:level";
  level: number;
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
    case "models_missing":
      return voice.modelsMissing;
  }
}

/**
 * Manual model provisioning, driven from Settings (the option only
 * shows when the wake word is enabled). Nothing downloads
 * automatically: Nila works without the models, and a wake with none
 * present surfaces the `models_missing` error code above.
 *
 * `status` mirrors the backend ModelManager: "installed" means the
 * files are present AND verified (a truncated download never counts).
 * "Update available" is not supported — the upstream release is pinned.
 */
export type SttModelStatus = "not_installed" | "downloading" | "installed";

export interface SttModelsStatus {
  status: SttModelStatus;
  /** Total bytes of the installed set; null unless installed. */
  size_bytes: number | null;
  /** Last download failure, if any; null when installed. */
  error: string | null;
}

export interface SttDownloadResult {
  /** False when the models were already present — nothing was started. */
  started: boolean;
}

/** Whether the STT models are present and verified. */
export function getSttModelsStatus(): Promise<SttModelsStatus> {
  return invokeCommand<SttModelsStatus>("stt_models_status");
}

/**
 * Start the one-time model download in the background. Progress,
 * completion and failure arrive on the MODEL_EVENTS events; the
 * returned `started` is false when the models were already present.
 */
export function downloadSttModels(): Promise<SttDownloadResult> {
  return invokeCommand<SttDownloadResult>("download_stt_models");
}

/**
 * Delete the downloaded models from the app-managed data directory
 * (env-override paths are never touched). Resolves true when at least
 * one file was removed.
 */
export function deleteSttModels(): Promise<boolean> {
  return invokeCommand<boolean>("delete_stt_models");
}
