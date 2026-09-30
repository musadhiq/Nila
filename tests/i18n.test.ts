import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  STRINGS,
  describeScheduleIn,
  fill,
  getStrings,
  type Language,
} from "../src/lib/i18n.ts";

const MALAYALAM_SCRIPT = /[\u0D00-\u0D7F]/;

function pathsOf(obj: unknown, prefix = ""): string[] {
  if (typeof obj === "string") return [prefix];
  if (Array.isArray(obj)) {
    return obj.flatMap((v, i) => pathsOf(v, `${prefix}[${i}]`));
  }
  if (obj && typeof obj === "object") {
    return Object.entries(obj).flatMap(([k, v]) =>
      pathsOf(v, prefix ? `${prefix}.${k}` : k),
    );
  }
  return [prefix];
}

function stringsOf(obj: unknown): string[] {
  if (typeof obj === "string") return [obj];
  if (Array.isArray(obj)) return obj.flatMap(stringsOf);
  if (obj && typeof obj === "object") return Object.values(obj).flatMap(stringsOf);
  return [];
}

describe("settings i18n dictionary", () => {
  it("English and Manglish have identical key structure", () => {
    const enPaths = pathsOf(STRINGS.en).sort();
    const mlPaths = pathsOf(STRINGS.manglish).sort();
    assert.deepEqual(mlPaths, enPaths);
  });

  it("no empty strings in either language", () => {
    for (const lang of ["en", "manglish"] as Language[]) {
      for (const s of stringsOf(STRINGS[lang])) {
        assert.ok(s.trim().length > 0, `${lang}: empty string`);
      }
    }
  });

  it("Manglish stays in Latin script (no Malayalam Unicode)", () => {
    for (const s of stringsOf(STRINGS.manglish)) {
      assert.doesNotMatch(s, MALAYALAM_SCRIPT, s.slice(0, 40));
    }
  });

  it("getStrings falls back to English for unknown languages", () => {
    assert.equal(
      getStrings("xx" as Language).window.title,
      getStrings("en").window.title,
    );
  });

  it("fill replaces {placeholders}", () => {
    assert.equal(fill("Paused until {time}", { time: "18:30" }), "Paused until 18:30");
    assert.equal(fill("{count} reminders", { count: 8 }), "8 reminders");
    assert.equal(fill("no vars", {}), "no vars");
  });

  it("describeScheduleIn localizes every schedule type", () => {
    const cases = [
      { type: "daily", time: "09:00" },
      { type: "weekly", days: [1, 3], time: "10:00" },
      { type: "interval", minutes: 90 },
      { type: "once", at: "2026-10-01T09:00:00.000Z" },
    ] as const;
    for (const lang of ["en", "manglish"] as Language[]) {
      for (const s of cases) {
        const text = describeScheduleIn(s as never, lang);
        assert.ok(text.length > 0, `${lang} ${s.type}`);
        assert.doesNotMatch(text, MALAYALAM_SCRIPT, `${lang} ${s.type}`);
      }
    }
    assert.match(describeScheduleIn({ type: "daily", time: "09:00" }, "en"), /Daily/);
    assert.match(
      describeScheduleIn({ type: "daily", time: "09:00" }, "manglish"),
      /Dinasavum/,
    );
    assert.match(
      describeScheduleIn({ type: "interval", minutes: 45 }, "manglish"),
      /45/,
    );
  });

  it("Manglish is not a copy of English (spot check)", () => {
    const en = STRINGS.en;
    const ml = STRINGS.manglish;
    const pairs: [string, string][] = [
      [en.page.general.subtitle, ml.page.general.subtitle],
      [en.general.startAtLogin, ml.general.startAtLogin],
      [en.notifications.behaviorCharacterDesc, ml.notifications.behaviorCharacterDesc],
      [en.errors.generic, ml.errors.generic],
      [en.reminders.emptyCustom, ml.reminders.emptyCustom],
    ];
    for (const [a, b] of pairs) {
      assert.notEqual(a, b, `Manglish should differ: ${a}`);
    }
  });
});
