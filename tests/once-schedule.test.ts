import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  describeScheduleIn,
  formatLocalDateTime,
} from "../src/lib/i18n.ts";
import { isPastIso, onceToIso } from "../src/lib/reminders.ts";

describe("onceToIso", () => {
  it("combines a local date and time into a UTC ISO instant", () => {
    const iso = onceToIso("2026-10-02", "15:30");
    assert.ok(iso);
    assert.match(iso!, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // Round-trips back to the same local wall-clock time.
    const d = new Date(iso!);
    assert.equal(d.getFullYear(), 2026);
    assert.equal(d.getMonth(), 9);
    assert.equal(d.getDate(), 2);
    assert.equal(d.getHours(), 15);
    assert.equal(d.getMinutes(), 30);
  });

  it("returns null when either part is missing or invalid", () => {
    assert.equal(onceToIso("", "15:30"), null);
    assert.equal(onceToIso("2026-10-02", ""), null);
    assert.equal(onceToIso("not-a-date", "15:30"), null);
    assert.equal(onceToIso("2026-10-02", "99:99"), null);
  });
});

describe("isPastIso", () => {
  it("flags past and invalid instants, passes future ones", () => {
    const now = Date.now();
    assert.equal(isPastIso(new Date(now - 60_000).toISOString(), now), true);
    assert.equal(isPastIso(new Date(now).toISOString(), now), true);
    assert.equal(isPastIso(new Date(now + 60_000).toISOString(), now), false);
    assert.equal(isPastIso("garbage", now), true);
  });
});

describe("formatLocalDateTime", () => {
  it("renders a local date-time, never a raw UTC ISO string", () => {
    // 10:00 UTC — must not leak through as "...T10:00:00.000Z".
    const out = formatLocalDateTime("2026-10-02T10:00:00.000Z");
    assert.doesNotMatch(out, /T\d{2}:\d{2}.*Z/);
    const d = new Date("2026-10-02T10:00:00.000Z");
    // Contains the local wall-clock reading for that instant.
    assert.ok(out.includes(String(d.getDate())));
    assert.ok(
      out.includes(`${d.getHours() % 12 || 12}`) || out.includes(`${d.getHours()}`),
    );
  });

  it("returns invalid input unchanged", () => {
    assert.equal(formatLocalDateTime("nope"), "nope");
  });
});

describe("describeScheduleIn once", () => {
  it("shows the local time, not the UTC value, in both languages", () => {
    for (const lang of ["en", "manglish"] as const) {
      const desc = describeScheduleIn(
        { type: "once", at: "2026-10-02T10:00:00.000Z" },
        lang,
      );
      assert.doesNotMatch(desc, /T\d{2}:\d{2}.*Z/);
      assert.doesNotMatch(desc, /UTC/i);
    }
    assert.ok(describeScheduleIn({ type: "once", at: "2026-10-02T10:00:00.000Z" }, "en").startsWith("Once"));
    assert.ok(
      describeScheduleIn({ type: "once", at: "2026-10-02T10:00:00.000Z" }, "manglish").startsWith("Oru thavana"),
    );
  });
});
