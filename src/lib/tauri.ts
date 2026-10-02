// Safe Tauri bridge. All backend access goes through here so the UI
// also runs (in a degraded demo mode) under plain `vite dev`, where
// the Rust backend is unavailable.

import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Invoke a Rust command; rejects with "tauri-unavailable" outside Tauri. */
export async function invokeCommand<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error("tauri-unavailable");
  return invoke<T>(cmd, args);
}

/** Listen for a backend event; no-op unlisten outside Tauri. */
export async function listenEvent<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<T>(event, (e) => handler(e.payload));
}

/** Emit a frontend event; no-op outside Tauri. */
export function emitEvent(event: string, payload?: unknown): void {
  if (!isTauri()) return;
  void emit(event, payload);
}
