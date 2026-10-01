import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MODEL_EVENTS,
  VOICE_EVENTS,
  voiceErrorLabel,
  type ModelsDownloadingPayload,
  type VoiceErrorCode,
} from "../src/lib/voice.ts";
import { STRINGS, type Language } from "../src/lib/i18n.ts";

describe("voice event contract", () => {
  it("uses the exact event names the backend emits", () => {
    assert.equal(VOICE_EVENTS.started, "voice:started");
    assert.equal(VOICE_EVENTS.partial, "voice:transcript_partial");
    assert.equal(VOICE_EVENTS.final, "voice:transcript_final");
    assert.equal(VOICE_EVENTS.processing, "voice:processing");
    assert.equal(VOICE_EVENTS.response, "voice:response");
    assert.equal(VOICE_EVENTS.error, "voice:error");
    assert.equal(VOICE_EVENTS.ended, "voice:ended");
  });

  it("maps every error code to a non-empty label in both languages", () => {
    const codes: VoiceErrorCode[] = [
      "speech_timeout",
      "empty_transcript",
      "mic_error",
      "model_error",
    ];
    for (const lang of ["en", "manglish"] as Language[]) {
      for (const code of codes) {
        const label = voiceErrorLabel(code, STRINGS[lang].voice);
        assert.ok(label.trim().length > 0, `${lang}/${code}: empty label`);
      }
    }
  });

  it("error labels differ per code (no accidental aliasing)", () => {
    const labels = (["speech_timeout", "empty_transcript", "mic_error", "model_error"] as VoiceErrorCode[])
      .map((c) => voiceErrorLabel(c, STRINGS.en.voice));
    assert.equal(new Set(labels).size, labels.length);
  });
});

describe("model provisioning events", () => {
  it("uses the exact event names the backend emits", () => {
    assert.equal(MODEL_EVENTS.downloading, "nila://models-downloading");
    assert.equal(MODEL_EVENTS.ready, "nila://models-ready");
    assert.equal(MODEL_EVENTS.error, "nila://models-error");
  });

  it("download progress payload carries byte counts for the UI", () => {
    const p: ModelsDownloadingPayload = {
      type: "nila://models-downloading",
      file: "model.int8.onnx",
      downloaded_bytes: 42,
      total_bytes: 100,
    };
    assert.equal(p.type, MODEL_EVENTS.downloading);
    assert.equal(p.file, "model.int8.onnx");
    assert.ok(p.downloaded_bytes <= p.total_bytes);
  });

  it("has a non-empty downloading line in both languages", () => {
    for (const lang of ["en", "manglish"] as Language[]) {
      const line = STRINGS[lang].voice.modelsDownloading;
      assert.ok(line.trim().length > 0, `${lang}: empty modelsDownloading`);
    }
  });
});
