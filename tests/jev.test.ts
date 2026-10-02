import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  JEV_EVENTS,
  jevResponse,
  testStatusLabel,
  type TestConnectionStatus,
} from "../src/lib/jev.ts";
import { STRINGS, type Language } from "../src/lib/i18n.ts";

const LANGS: Language[] = ["en", "manglish"];

describe("jev event contract", () => {
  it("uses the exact event names the Rust service emits", () => {
    assert.equal(JEV_EVENTS.processing, "jev:processing");
    assert.equal(JEV_EVENTS.actionDetected, "jev:action_detected");
    assert.equal(JEV_EVENTS.confirmationRequired, "jev:confirmation_required");
    assert.equal(JEV_EVENTS.result, "jev:result");
    assert.equal(JEV_EVENTS.error, "jev:error");
    assert.equal(JEV_EVENTS.uiAction, "jev:ui_action");
  });
});

describe("jev i18n coverage", () => {
  it("every backend response_key has a template in both languages", () => {
    const keys = [
      "openingApp",
      "appNotFound",
      "appLaunchFailed",
      "closingApp",
      "appNotRunning",
      "appCloseFailed",
      "appCloseUnsupported",
      "filesFound",
      "noFilesFound",
      "openingFile",
      "fileNotFound",
      "fileOpenFailed",
      "noFileInContext",
      "openingFolder",
      "folderNotFound",
      "folderOpenFailed",
      "folderCreated",
      "folderExists",
      "folderCreateFailed",
      "reminderSet",
      "reminderSetFailed",
      "reminderCancelled",
      "noReminderToCancel",
      "ramUsage",
      "cpuUsage",
      "diskUsage",
      "batteryStatus",
      "batteryCharging",
      "noBattery",
      "systemSummary",
      "systemInfoFailed",
      "okayCancelled",
      "unknownCommand",
      "emptyTranscript",
      "convGreeting",
      "convHowAreYou",
      "convWhatIsYourName",
      "convWhoAreYou",
      "convHelp",
      "convThanks",
      "convGoodbye",
      "convCurrentTime",
      "convCurrentDate",
      "jevNotConfigured",
      "jevInvalidToken",
      "jevNetworkError",
      "jevServiceUnavailable",
      "jevInternalError",
    ];
    for (const lang of LANGS) {
      const responses = STRINGS[lang].jev.responses as Record<string, string>;
      for (const k of keys) {
        assert.ok(
          typeof responses[k] === "string" && responses[k].length > 0,
          `${lang}: missing response template for ${k}`,
        );
      }
    }
  });

  it("settings strings exist in both languages", () => {
    for (const lang of LANGS) {
      const j = STRINGS[lang].jev;
      for (const k of [
        "title",
        "connected",
        "notConfigured",
        "intro",
        "addToken",
        "tokenLabel",
        "testConnection",
        "remove",
        "maskedToken",
        "securityNote",
      ] as const) {
        assert.ok(j[k].length > 0, `${lang}: jev.${k} empty`);
      }
      assert.equal(STRINGS[lang].nav.jev, "AI / Jev");
    }
  });
});

describe("jevResponse", () => {
  it("fills placeholders", () => {
    assert.equal(
      jevResponse("openingApp", { app: "Firefox" }, STRINGS.en),
      "Opening Firefox.",
    );
    assert.equal(
      jevResponse("openingApp", { app: "Firefox" }, STRINGS.manglish),
      "Firefox open cheyyunnu.",
    );
  });

  it("picks the charging variant for batteryStatus", () => {
    const charging = jevResponse(
      "batteryStatus",
      { pct: 80, discharging: false },
      STRINGS.en,
    );
    assert.ok(charging.includes("charging"), charging);
    const draining = jevResponse(
      "batteryStatus",
      { pct: 80, discharging: true },
      STRINGS.en,
    );
    assert.ok(!draining.includes("charging"), draining);
  });

  it("degrades unknown keys to the unknown-command line", () => {
    const msg = jevResponse("noSuchKey", {}, STRINGS.en);
    assert.equal(msg, STRINGS.en.jev.responses.unknownCommand);
  });

  it("leaves unreplaced placeholders visible rather than crashing", () => {
    const msg = jevResponse("openingApp", {}, STRINGS.en);
    assert.ok(msg.includes("{app}"), msg);
  });
});

describe("testStatusLabel", () => {
  it("labels every test status in both languages", () => {
    const statuses: TestConnectionStatus[] = [
      "connected",
      "invalid_token",
      "network_error",
      "service_unavailable",
      "not_configured",
    ];
    for (const lang of LANGS) {
      for (const s of statuses) {
        const label = testStatusLabel(s, STRINGS[lang]);
        assert.ok(label.length > 0, `${lang}/${s}: empty label`);
      }
    }
  });
});
