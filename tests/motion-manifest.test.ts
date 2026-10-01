import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import {
  BLINK_KEY,
  CORE_SEQUENCE_NAMES,
  MOTION_SEQUENCES,
  allManifestKeys,
  nextBlinkDelayMs,
  peekSequenceForPreset,
  resolveFrameKey,
} from "../src/character/motionManifest.ts";

const MOTION_DIR = new URL("../character/motion/", import.meta.url);

/** All committed frame PNGs, keyed by basename (sheets/ excluded). */
function framesOnDisk(): Set<string> {
  const keys = new Set<string>();
  const walk = (dir: URL) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "sheets") continue;
      const full = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".png")) {
        keys.add(entry.name.slice(0, -".png".length));
      }
    }
  };
  walk(MOTION_DIR);
  return keys;
}

describe("motionManifest", () => {
  it("every manifest key maps to a committed PNG on disk", () => {
    const onDisk = framesOnDisk();
    assert.ok(onDisk.size > 100, `expected 100+ frames, got ${onDisk.size}`);
    const missing = allManifestKeys().filter((k) => !onDisk.has(k));
    assert.deepEqual(missing, [], `manifest keys with no PNG: ${missing.join(", ")}`);
  });

  it("every sequence is well-formed (frames, timing, loop, anchor)", () => {
    for (const [name, def] of Object.entries(MOTION_SEQUENCES)) {
      assert.ok(def.frames.length >= 1, `${name}: needs at least one frame`);
      assert.ok(
        ["none", "loop", "pingpong"].includes(def.loop),
        `${name}: bad loop ${def.loop}`,
      );
      for (const f of def.frames) {
        assert.ok(f.key.length > 0, `${name}: empty frame key`);
        assert.ok(f.ms > 0, `${name}/${f.key}: ms must be positive`);
      }
      if (def.anchor) {
        assert.ok(
          ["left", "center", "right"].includes(def.anchor.x),
          `${name}: bad anchor.x`,
        );
        assert.ok(
          ["top", "center", "bottom"].includes(def.anchor.y),
          `${name}: bad anchor.y`,
        );
      }
    }
  });

  it("the full reminder arc and core sequences exist", () => {
    for (const name of [
      "idle",
      "wave",
      "reminder-enter",
      "reminder-point",
      "reminder-wait",
      "reminder-react",
      "reminder-retreat",
      "snooze-ack",
      "thumbsup",
      "sleep",
      "celebration",
      ...CORE_SEQUENCE_NAMES,
    ]) {
      assert.ok(MOTION_SEQUENCES[name], `missing sequence: ${name}`);
    }
    assert.ok(BLINK_KEY.length > 0);
  });

  it("peek mapping covers all 9 presets; center has no peek", () => {
    const presets = [
      "top-left",
      "top",
      "top-right",
      "left",
      "center",
      "right",
      "bottom-left",
      "bottom",
      "bottom-right",
    ];
    for (const preset of presets) {
      const seq = peekSequenceForPreset(preset, false);
      if (preset === "center") {
        assert.equal(seq, null, "center must not map to a peek sequence");
      } else {
        assert.ok(seq, `${preset}: expected a peek sequence`);
        assert.ok(
          MOTION_SEQUENCES[seq!.enter],
          `${preset}: missing enter ${seq!.enter}`,
        );
        assert.ok(
          MOTION_SEQUENCES[seq!.exit],
          `${preset}: missing exit ${seq!.exit}`,
        );
      }
    }
    // Top hang uses the hanging set when enabled.
    const hang = peekSequenceForPreset("top", true)!;
    assert.ok(hang.enter.includes("hang"), `top+hang enter: ${hang.enter}`);
    const noHang = peekSequenceForPreset("top", false)!;
    assert.ok(!noHang.enter.includes("hang"), `top enter: ${noHang.enter}`);
  });

  it("resolveFrameKey: exact hit, numbered sibling, then idle", () => {
    const avail = new Set(["nila_wave_05", "nila_idle_01"]);
    assert.equal(resolveFrameKey("nila_wave_05", avail), "nila_wave_05");
    // Nearest numbered sibling (down preferred).
    assert.equal(resolveFrameKey("nila_wave_06", avail), "nila_wave_05");
    assert.equal(resolveFrameKey("nila_wave_04", avail), "nila_wave_05");
    // Unknown key falls back to idle.
    assert.equal(resolveFrameKey("nila_nope", avail), "nila_idle_01");
    // Nothing usable -> null (caller uses the legacy image).
    assert.equal(resolveFrameKey("nila_nope", new Set()), null);
  });

  it("blink delay is irregular but bounded to 3.5-7s", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const d = nextBlinkDelayMs();
      assert.ok(d >= 3500 && d <= 7000, `blink delay out of range: ${d}`);
      seen.add(Math.round(d));
    }
    assert.ok(seen.size > 50, "blink delay should vary, not repeat one value");
  });

  it("enter sequences settle (last frame lingers) and exits hurry away", () => {
    const enter = MOTION_SEQUENCES["peek-right"].frames;
    const exit = MOTION_SEQUENCES["peek-right-exit"].frames;
    assert.ok(
      enter[enter.length - 1].ms >= enter[0].ms,
      "enter should end slower than it starts",
    );
    assert.ok(
      exit[0].ms >= exit[exit.length - 1].ms,
      "exit should start settled and hurry away",
    );
    // Exit plays the same frames in reverse.
    assert.deepEqual(
      exit.map((f) => f.key),
      enter.map((f) => f.key).reverse(),
    );
  });
});
