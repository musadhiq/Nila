import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  VoiceCommandPipeline,
  type PipelineDeps,
  type PipelineHost,
  type PipelinePhase,
} from "../src/lib/voiceCommandPipeline.ts";
import type { JevResultPayload, JevError } from "../src/lib/jev.ts";
import { STRINGS } from "../src/lib/i18n.ts";

/** Records what the pipeline asked the host to do. */
function makeHost() {
  const renders: { phase: PipelinePhase; text: string }[] = [];
  const answers: { message: string; intent: string }[] = [];
  const host: PipelineHost = {
    render: (phase, text) => renders.push({ phase, text }),
    answer: (message, intent) => answers.push({ message, intent }),
    strings: () => STRINGS.en,
  };
  return { host, renders, answers };
}

function okDeps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    getStatus: async () => ({ configured: false, connected: false }),
    sendToJev: async () => {},
    ...overrides,
  };
}

function resultPayload(overrides: Partial<JevResultPayload> = {}): JevResultPayload {
  return {
    intent: "open_application",
    status: "success",
    response_key: "openingApp",
    response_params: { app: "Firefox" },
    data: null,
    ...overrides,
  };
}

describe("VoiceCommandPipeline", () => {
  it("forwards a cleaned final transcript to Jev", async () => {
    const { host, renders } = makeHost();
    let sent = "";
    const p = new VoiceCommandPipeline(
      host,
      okDeps({ sendToJev: async (t) => { sent = t; } }),
    );
    const d = await p.handleFinalTranscript("  open firefox\n");
    assert.deepEqual(d, { kind: "forwarded" });
    assert.equal(sent, "open firefox"); // trimmed
    assert.equal(p.currentPhase, "processing");
    assert.ok(p.isActive());
    assert.deepEqual(renders[0], { phase: "processing", text: "open firefox" });
    p.dispose();
  });

  it("never forwards an empty transcript", async () => {
    const { host, answers } = makeHost();
    let sent = false;
    const p = new VoiceCommandPipeline(
      host,
      okDeps({ sendToJev: async () => { sent = true; } }),
    );
    const d = await p.handleFinalTranscript("   \n ");
    assert.deepEqual(d, { kind: "empty" });
    assert.equal(sent, false);
    assert.equal(p.isActive(), false);
    assert.equal(answers.length, 0);
    p.dispose();
  });

  it("shows an error when the Jev service is unreachable", async () => {
    const { host, answers } = makeHost();
    let sent = false;
    const p = new VoiceCommandPipeline(
      host,
      okDeps({
        getStatus: async () => { throw new Error("nope"); },
        sendToJev: async () => { sent = true; },
      }),
    );
    const d = await p.handleFinalTranscript("open firefox");
    assert.deepEqual(d, { kind: "unavailable" });
    assert.equal(sent, false);
    assert.equal(p.isActive(), false);
    assert.equal(answers.length, 1);
    assert.ok(answers[0].message.length > 0);
    p.dispose();
  });

  it("shows an error when sending to Jev fails", async () => {
    const { host, answers } = makeHost();
    const p = new VoiceCommandPipeline(
      host,
      okDeps({
        sendToJev: async () => { throw new Error("invoke failed"); },
      }),
    );
    const d = await p.handleFinalTranscript("open firefox");
    assert.deepEqual(d, { kind: "unavailable" });
    assert.equal(answers.length, 1);
    p.dispose();
  });

  it("walks processing -> executing -> response on the happy path", async () => {
    const { host, renders, answers } = makeHost();
    const p = new VoiceCommandPipeline(host, okDeps());
    await p.handleFinalTranscript("open firefox");
    assert.equal(p.currentPhase, "processing");

    p.handleJevProcessing();
    assert.equal(p.currentPhase, "processing");

    p.handleActionDetected("open_application");
    assert.equal(p.currentPhase, "executing");
    assert.deepEqual(renders[renders.length - 1].phase, "executing");

    p.handleResult(resultPayload());
    assert.equal(answers.length, 1);
    assert.equal(answers[0].message, "Opening Firefox.");
    assert.equal(answers[0].intent, "open_application");
    assert.equal(p.isActive(), false); // back to idle after the answer
    p.dispose();
  });

  it("unknown intents surface as Nila's normal response, not a crash", async () => {
    const { answers } = makeHost();
    const host = makeHost();
    const p = new VoiceCommandPipeline(host.host, okDeps());
    await p.handleFinalTranscript("do something weird");
    p.handleResult(
      resultPayload({
        intent: "unknown",
        status: "error",
        response_key: "unknownCommand",
        response_params: {},
      }),
    );
    assert.equal(host.answers.length, 1);
    assert.equal(host.answers[0].message, STRINGS.en.jev.responses.unknownCommand);
    assert.equal(host.answers[0].intent, "unknown");
    assert.equal(p.isActive(), false);
    assert.equal(answers.length, 0);
    p.dispose();
  });

  it("maps every Jev error to a localized message", async () => {
    const cases: { code: string; key: string }[] = [
      { code: "not_configured", key: "jevNotConfigured" },
      { code: "invalid_token", key: "jevInvalidToken" },
      { code: "network_error", key: "jevNetworkError" },
      { code: "service_unavailable", key: "jevServiceUnavailable" },
      { code: "empty_transcript", key: "emptyTranscript" },
      { code: "internal", key: "jevInternalError" },
    ];
    for (const c of cases) {
      const host = makeHost();
      const p = new VoiceCommandPipeline(host.host, okDeps());
      await p.handleFinalTranscript("open firefox");
      const err: JevError = { code: c.code, response_key: c.key };
      p.handleError(err);
      assert.equal(host.answers.length, 1, c.code);
      assert.equal(host.answers[0].message, (STRINGS.en.jev.responses as Record<string, string>)[c.key], c.code);
      assert.equal(host.answers[0].intent, "error");
      assert.equal(p.isActive(), false, c.code);
      p.dispose();
    }
  });

  it("ignores stale Jev events when no command is active", async () => {
    const host = makeHost();
    const p = new VoiceCommandPipeline(host.host, okDeps());
    // No handleFinalTranscript call — these must be no-ops, not crashes.
    p.handleJevProcessing();
    p.handleActionDetected("open_application");
    p.handleResult(resultPayload());
    p.handleError({ code: "network_error", response_key: "jevNetworkError" });
    assert.equal(host.answers.length, 0);
    assert.equal(host.renders.length, 0);
    assert.equal(p.isActive(), false);
    p.dispose();
  });

  it("drops a second transcript while a command is in flight", async () => {
    const host = makeHost();
    let sends = 0;
    const p = new VoiceCommandPipeline(
      host.host,
      okDeps({ sendToJev: async () => { sends++; } }),
    );
    const first = await p.handleFinalTranscript("open firefox");
    assert.deepEqual(first, { kind: "forwarded" });
    assert.equal(sends, 1);

    // Second final while the first is still processing: dropped, not duplicated.
    const second = await p.handleFinalTranscript("close firefox");
    assert.deepEqual(second, { kind: "busy" });
    assert.equal(sends, 1);
    assert.equal(p.currentPhase, "processing");

    // Once the first command finishes, the pipeline accepts work again.
    p.handleResult(resultPayload());
    assert.equal(p.isActive(), false);
    const third = await p.handleFinalTranscript("close firefox");
    assert.deepEqual(third, { kind: "forwarded" });
    assert.equal(sends, 2);
    p.dispose();
  });

  it("a voice error abandons the pending command", async () => {
    const host = makeHost();
    const p = new VoiceCommandPipeline(host.host, okDeps());
    await p.handleFinalTranscript("open firefox");
    assert.equal(p.isActive(), true);
    p.handleVoiceError();
    assert.equal(p.isActive(), false);
    // A late jev:result for the abandoned command is ignored.
    p.handleResult(resultPayload());
    assert.equal(host.answers.length, 0);
    p.dispose();
  });

  it("a UI action completes the pipeline silently (no spoken response)", async () => {
    const host = makeHost();
    const p = new VoiceCommandPipeline(host.host, okDeps());
    await p.handleFinalTranscript("set a reminder");
    assert.equal(p.isActive(), true);
    p.handleUiAction();
    assert.equal(p.isActive(), false);
    // No answer was spoken — the opening UI is the response.
    assert.equal(host.answers.length, 0);
    p.dispose();
  });

  it("ignores a UI action when no command is active", async () => {
    const host = makeHost();
    const p = new VoiceCommandPipeline(host.host, okDeps());
    p.handleUiAction();
    assert.equal(p.isActive(), false);
    assert.equal(host.answers.length, 0);
    p.dispose();
  });
});
