import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  SLOT_FILENAMES,
  SLOT_BLINK_FILENAMES,
} from "../src/dock/expressionSlots.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const expressionsDir = join(repoRoot, "character", "expressions");
const bindingSource = readFileSync(
  join(repoRoot, "src", "dock", "expressions.ts"),
  "utf8",
);
const blinkBindingSource = readFileSync(
  join(repoRoot, "src", "dock", "blinkFrames.ts"),
  "utf8",
);

describe("expression assets", () => {
  it("every slot maps to a committed PNG on disk", () => {
    for (const [slot, filename] of Object.entries(SLOT_FILENAMES)) {
      const path = join(expressionsDir, filename);
      assert.ok(
        existsSync(path),
        `slot "${slot}" -> missing file ${path}`,
      );
    }
  });

  it("every slot is bound to its PNG in src/dock/expressions.ts", () => {
    for (const [slot, filename] of Object.entries(SLOT_FILENAMES)) {
      assert.ok(
        bindingSource.includes(filename),
        `slot "${slot}" (${filename}) has no binding in expressions.ts`,
      );
    }
  });

  it("the binding table covers every slot exactly once", () => {
    const slots = Object.keys(SLOT_FILENAMES);
    // 13 slots: greeting, 8 kind expressions, pointing, playful,
    // happy, sad, annoyed.
    assert.equal(slots.length, 13);
    assert.equal(new Set(Object.values(SLOT_FILENAMES)).size, slots.length);
  });
});

describe("blink frame assets", () => {
  it("every slot has half-blink and fully-closed PNGs on disk", () => {
    for (const [slot, frames] of Object.entries(SLOT_BLINK_FILENAMES)) {
      for (const [phase, filename] of Object.entries(frames)) {
        const path = join(expressionsDir, filename);
        assert.ok(
          existsSync(path),
          `slot "${slot}" ${phase} -> missing file ${path}`,
        );
      }
    }
  });

  it("every blink frame is bound in src/dock/blinkFrames.ts", () => {
    for (const [slot, frames] of Object.entries(SLOT_BLINK_FILENAMES)) {
      for (const [phase, filename] of Object.entries(frames)) {
        assert.ok(
          blinkBindingSource.includes(filename),
          `slot "${slot}" ${phase} (${filename}) has no binding in blinkFrames.ts`,
        );
      }
    }
  });

  it("the blink table covers every slot exactly once with unique files", () => {
    const slots = Object.keys(SLOT_BLINK_FILENAMES);
    assert.deepEqual(new Set(slots), new Set(Object.keys(SLOT_FILENAMES)));
    const files = Object.values(SLOT_BLINK_FILENAMES).flatMap((f) => [
      f.half,
      f.closed,
    ]);
    assert.equal(files.length, slots.length * 2);
    assert.equal(new Set(files).size, files.length);
  });
});
