import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  VOICE_EVENTS,
  voiceErrorLabel,
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
