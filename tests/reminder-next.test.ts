import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatNextIn } from "../src/lib/i18n.ts";

describe("formatNextIn", () => {
  const now = Date.parse("2026-10-01T10:00:00Z");
  const iso = (mins: number) => new Date(now + mins * 60000).toISOString();

  it("formats minutes under an hour", () => {
    assert.equal(formatNextIn(iso(45), "en", now), "in 45 min");
    assert.equal(formatNextIn(iso(45), "manglish", now), "45 minute kazhinj");
  });

  it("formats hours", () => {
    assert.equal(formatNextIn(iso(120), "en", now), "in 2 hr");
    assert.equal(formatNextIn(iso(120), "manglish", now), "2 manikkoor kazhinj");
  });

  it("formats days beyond 48 hours", () => {
    assert.equal(formatNextIn(iso(60 * 50), "en", now), "in 2 days");
    assert.equal(
      formatNextIn(iso(60 * 50), "manglish", now),
      "2 divasam kazhinj",
    );
  });

  it("returns null for past, invalid, or missing timestamps", () => {
    assert.equal(formatNextIn(iso(-5), "en", now), null);
    assert.equal(formatNextIn(iso(0), "en", now), null);
    assert.equal(formatNextIn("bogus", "en", now), null);
    assert.equal(formatNextIn(null, "en", now), null);
    assert.equal(formatNextIn(undefined, "en", now), null);
  });
});
