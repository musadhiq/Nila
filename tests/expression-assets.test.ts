import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SLOT_FILENAMES } from "../src/dock/expressionSlots.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const expressionsDir = join(repoRoot, "character", "expressions");
const bindingSource = readFileSync(
  join(repoRoot, "src", "dock", "expressions.ts"),
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
