import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MODEL_EVENTS,
  VOICE_EVENTS,
  deleteSttModels,
  downloadSttModels,
  getSttModelsStatus,
  voiceErrorLabel,
  type ModelsDownloadingPayload,
  type SttModelsStatus,
  type VoiceErrorCode,
} from "../src/lib/voice.ts";
import { STRINGS, type Language } from "../src/lib/i18n.ts";

const ALL_CODES: VoiceErrorCode[] = [
  "speech_timeout",
  "empty_transcript",
  "mic_error",
  "model_error",
  "models_missing",
];

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
    for (const lang of ["en", "manglish"] as Language[]) {
      for (const code of ALL_CODES) {
        const label = voiceErrorLabel(code, STRINGS[lang].voice);
        assert.ok(label.trim().length > 0, `${lang}/${code}: empty label`);
      }
    }
  });

  it("error labels differ per code (no accidental aliasing)", () => {
    const labels = ALL_CODES.map((c) => voiceErrorLabel(c, STRINGS.en.voice));
    assert.equal(new Set(labels).size, labels.length);
  });

  it("models_missing points at Settings in both languages", () => {
    for (const lang of ["en", "manglish"] as Language[]) {
      const label = voiceErrorLabel("models_missing", STRINGS[lang].voice);
      assert.ok(label.includes("Settings"), `${lang}: ${label}`);
      assert.notEqual(
        label,
        voiceErrorLabel("model_error", STRINGS[lang].voice),
        `${lang}: models_missing aliases model_error`,
      );
    }
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

  it("settings download strings exist in both languages", () => {
    for (const lang of ["en", "manglish"] as Language[]) {
      const g = STRINGS[lang].general;
      for (const key of [
        "voiceModelsSection",
        "voiceModelsDesc",
        "voiceModelsReady",
        "voiceModelsMissing",
        "voiceModelsDownload",
        "voiceModelsDownloading",
        "voiceModelsFailed",
        "voiceModelsDelete",
        "voiceModelsSize",
        "voiceModelsError",
      ] as const) {
        assert.ok(g[key].trim().length > 0, `${lang}: empty ${key}`);
      }
      // The progress template carries a {pct} placeholder.
      assert.ok(g.voiceModelsDownloading.includes("{pct}"));
      assert.ok(g.voiceModelsError.includes("{msg}"));
    }
  });
});

describe("manual model download commands", () => {
  it("rejects outside Tauri (settings UI gates on isTauri)", async () => {
    await assert.rejects(getSttModelsStatus(), /tauri-unavailable/);
    await assert.rejects(downloadSttModels(), /tauri-unavailable/);
    await assert.rejects(deleteSttModels(), /tauri-unavailable/);
  });

  it("status shape matches the backend ModelInfo contract", () => {
    // Compile-time shape check against the Rust ModelInfo serialization:
    // { status, size_bytes, error }.
    const s: SttModelsStatus = {
      status: "installed",
      size_bytes: 83_400_000,
      error: null,
    };
    assert.equal(s.status, "installed");
    const missing: SttModelsStatus = {
      status: "not_installed",
      size_bytes: null,
      error: "boom",
    };
    assert.equal(missing.error, "boom");
  });
});
