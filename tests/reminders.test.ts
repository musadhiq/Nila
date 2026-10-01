import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BUILT_IN_TEMPLATES,
  describeSchedule,
  mergeSettings,
  parseSchedule,
  scheduleToJson,
  settingsToRecord,
  toReminder,
} from "../src/lib/reminders.ts";
import { DEFAULT_SETTINGS } from "../src/lib/types.ts";

describe("schedule parsing", () => {
  it("parses all four schedule shapes", () => {
    assert.deepEqual(parseSchedule('{"type":"daily","time":"09:00"}'), {
      type: "daily",
      time: "09:00",
    });
    assert.deepEqual(parseSchedule('{"type":"weekly","days":[1,3],"time":"18:30"}'), {
      type: "weekly",
      days: [1, 3],
      time: "18:30",
    });
    assert.deepEqual(parseSchedule('{"type":"interval","minutes":45}'), {
      type: "interval",
      minutes: 45,
    });
    const once = parseSchedule('{"type":"once","at":"2030-01-01T09:00:00Z"}');
    assert.equal(once.type, "once");
  });

  it("parses system schedules (backend monitor)", () => {
    assert.deepEqual(parseSchedule('{"type":"system","metric":"battery_low"}'), {
      type: "system",
      metric: "battery_low",
    });
    assert.deepEqual(parseSchedule('{"type":"system","metric":"cpu_high"}'), {
      type: "system",
      metric: "cpu_high",
    });
    // Unknown metrics fall back to battery_low rather than throwing:
    // the backend owns the canonical set.
    assert.deepEqual(parseSchedule('{"type":"system","metric":"warp"}'), {
      type: "system",
      metric: "battery_low",
    });
  });

  it("rejects unknown schedule types", () => {
    assert.throws(() => parseSchedule('{"type":"bogus"}'));
    assert.throws(() => parseSchedule("not json"));
  });

  it("round-trips through JSON", () => {
    const s = { type: "interval", minutes: 90 } as const;
    assert.deepEqual(parseSchedule(scheduleToJson(s)), s);
  });

  it("describes schedules in English", () => {
    assert.match(describeSchedule({ type: "daily", time: "09:00" }), /Daily/);
    assert.match(describeSchedule({ type: "interval", minutes: 60 }), /60/);
    assert.match(
      describeSchedule({ type: "weekly", days: [0, 6], time: "10:00" }),
      /Sun/,
    );
  });
});

describe("reminder DTO conversion", () => {
  it("converts backend DTOs to typed reminders", () => {
    const r = toReminder({
      id: "r1",
      title: "Vellam",
      message: "Vellam kudicho?",
      kind: "water",
      schedule: '{"type":"interval","minutes":60}',
      enabled: true,
    });
    assert.equal(r.kind, "water");
    assert.deepEqual(r.schedule, { type: "interval", minutes: 60 });
  });
});

describe("settings merge", () => {
  it("applies valid values over defaults and ignores garbage", () => {
    const s = mergeSettings({
      quiet_start: "23:00",
      daily_limit: "12",
      cooldown_minutes: "abc",
      animation: "reduced",
      character_size: "huge",
    });
    assert.equal(s.quiet_start, "23:00");
    assert.equal(s.daily_limit, 12);
    assert.equal(s.cooldown_minutes, DEFAULT_SETTINGS.cooldown_minutes);
    assert.equal(s.animation, "reduced");
    assert.equal(s.character_size, DEFAULT_SETTINGS.character_size);
  });

  it("round-trips through record form", () => {
    const s = mergeSettings(settingsToRecord(DEFAULT_SETTINGS));
    assert.deepEqual(s, DEFAULT_SETTINGS);
  });
});

describe("built-in templates", () => {
  it("covers the eight core kinds with valid schedules", () => {
    const kinds = BUILT_IN_TEMPLATES.map((t) => t.kind).sort();
    assert.deepEqual(kinds, [
      "break",
      "exercise",
      "food",
      "move",
      "sleep",
      "stretch",
      "water",
      "work",
    ]);
    for (const t of BUILT_IN_TEMPLATES) {
      assert.ok(t.title.length > 0);
      assert.ok(t.message.length > 0);
      // Must survive a JSON round-trip (this is what the backend stores).
      parseSchedule(scheduleToJson(t.schedule));
    }
  });
});
