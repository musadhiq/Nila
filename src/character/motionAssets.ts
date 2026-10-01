// motionAssets.ts — Vite-side motion asset resolution and preloading.
//
// This module is Vite-only (import.meta.glob): it is imported by
// NilaCharacter.tsx / App.tsx, never by node tests. The manifest
// (motionManifest.ts) stays PNG-free so tests can import it.
//
// Frames within one sequence share a canvas size and registration, so
// playback needs no per-frame measurement — the renderer uses a fixed
// stage with a bottom-center (or edge) anchor.

import {
  BLINK_KEY,
  CORE_SEQUENCE_NAMES,
  MOTION_SEQUENCES,
  allManifestKeys,
  resolveFrameKey,
} from "./motionManifest";

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  return path.slice(slash + 1, dot);
}

// Eager glob: every motion frame becomes a bundled asset URL at build
// time. The sheets/ directory holds regeneration sources, not frames —
// the negative pattern keeps them out of the bundle entirely (a runtime
// filter alone would not: eager matches are bundled regardless).
const modules = import.meta.glob(
  ["../../character/motion/**/*.png", "!../../character/motion/sheets/**"],
  {
    eager: true,
    import: "default",
  },
) as Record<string, string>;

const KEY_TO_URL = new Map<string, string>();
for (const [path, url] of Object.entries(modules)) {
  if (path.includes("/sheets/")) continue;
  KEY_TO_URL.set(basename(path), url);
}

const AVAILABLE_KEYS = new Set(KEY_TO_URL.keys());

/**
 * Resolve a manifest frame key to a bundled URL, applying the fallback
 * hierarchy (specific -> sibling -> sequence first -> idle -> null).
 * Never throws; null means "use the legacy state image".
 */
export function frameUrl(requestedKey: string): string | null {
  const key = resolveFrameKey(requestedKey, AVAILABLE_KEYS);
  if (!key) return null;
  return KEY_TO_URL.get(key) ?? null;
}

/** All asset keys actually bundled (for the dev gallery). */
export function availableFrameKeys(): string[] {
  return [...AVAILABLE_KEYS].sort();
}

const preloaded = new Set<string>();

function loadImage(url: string): Promise<void> {
  if (typeof Image === "undefined") return Promise.resolve();
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = "async";
    const done = () => resolve();
    img.onload = done;
    img.onerror = done; // a missing frame must never break playback
    img.src = url;
    // decode() warms the raster cache; ignore failures.
    if (typeof img.decode === "function") {
      img.decode().then(done, done);
    }
  });
}

/**
 * Preload a set of frame keys. Deduplicated across calls; resolves when
 * every image has loaded or failed. Failures resolve, never reject.
 */
export function preloadFrames(keys: readonly string[]): Promise<void> {
  const fresh: string[] = [];
  for (const key of keys) {
    const url = KEY_TO_URL.get(key);
    if (url && !preloaded.has(key)) {
      preloaded.add(key);
      fresh.push(url);
    }
  }
  if (fresh.length === 0) return Promise.resolve();
  return Promise.all(fresh.map(loadImage)).then(() => undefined);
}

/** Preload every frame of the named sequences. */
export function preloadSequences(names: readonly string[]): Promise<void> {
  const keys: string[] = [];
  for (const name of names) {
    const seq = MOTION_SEQUENCES[name];
    if (seq) for (const f of seq.frames) keys.push(f.key);
  }
  return preloadFrames(keys);
}

/**
 * Minimum viable preload before Nila first appears: idle + blink + wave
 * + the full reminder arc + the peek set for her current position.
 */
export function preloadForFirstAppearance(peekSeqNames: string[]): Promise<void> {
  const keys = new Set<string>([BLINK_KEY]);
  for (const name of CORE_SEQUENCE_NAMES) {
    const seq = MOTION_SEQUENCES[name];
    if (seq) for (const f of seq.frames) keys.add(f.key);
  }
  for (const name of peekSeqNames) {
    const seq = MOTION_SEQUENCES[name];
    if (seq) for (const f of seq.frames) keys.add(f.key);
  }
  return preloadFrames([...keys]);
}

/**
 * Lazy-load everything else in small background chunks so the first
 * paint is never blocked by sleep/corner assets.
 */
export function backgroundPreloadAll(chunkMs = 400): void {
  // No motion assets on disk (the generated library was retired): don't
  // arm a chain of wake-up timers for nothing.
  if (KEY_TO_URL.size === 0) return;
  const remaining = allManifestKeys().filter((k) => !preloaded.has(k));
  let i = 0;
  const step = () => {
    const chunk = remaining.slice(i, i + 8);
    i += chunk.length;
    if (chunk.length > 0) {
      void preloadFrames(chunk).then(() => {
        if (i < remaining.length) window.setTimeout(step, chunkMs);
      });
    }
  };
  window.setTimeout(step, chunkMs);
}

/** For tests/dev: how many frames are currently preloaded. */
export function preloadedCount(): number {
  return preloaded.size;
}
