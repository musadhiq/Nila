/**
 * Jev — frontend side of the voice-command action layer.
 *
 * Jev itself lives in Rust (intent parsing → schema validation →
 * allowlisted executor). This module is the thin bridge:
 *
 * - Tauri commands for Settings → AI / Jev (status, set, remove, test).
 * - The `jev:*` event contract from the Rust service.
 * - Nila's response layer: `jevResponse()` turns the machine-readable
 *   {response_key, response_params} into EN/Manglish text.
 *
 * The raw API token is NEVER persisted here — no localStorage, no
 * IndexedDB, no settings JSON. It exists in memory only inside the
 * "add token" form, then goes straight to Rust.
 */

import { invokeCommand } from "./tauri.ts";
import type { Dict } from "./i18n";

export const JEV_EVENTS = {
  processing: "jev:processing",
  actionDetected: "jev:action_detected",
  confirmationRequired: "jev:confirmation_required",
  result: "jev:result",
  error: "jev:error",
} as const;

export interface JevStatus {
  configured: boolean;
  connected: boolean;
}

export type TestConnectionStatus =
  | "connected"
  | "invalid_token"
  | "network_error"
  | "service_unavailable"
  | "not_configured";

export interface TestConnectionReport {
  status: TestConnectionStatus;
}

export interface JevResultPayload {
  intent: string;
  status: "success" | "error";
  response_key: string;
  response_params: Record<string, unknown>;
  data: {
    files?: { name: string; path: string }[];
    total?: number;
  } | null;
}

export interface JevError {
  code: string;
  response_key: string;
}

/** Status for Settings → AI / Jev. Never contains the token. */
export async function jevGetStatus(): Promise<JevStatus> {
  return invokeCommand<JevStatus>("jev_get_status");
}

/** Store the token in the OS keychain (via Rust). */
export async function jevSetToken(token: string): Promise<void> {
  await invokeCommand("jev_set_token", { token });
}

/** Remove the token from the OS keychain. */
export async function jevRemoveToken(): Promise<void> {
  await invokeCommand("jev_remove_token");
}

/** Lightweight authenticated probe. */
export async function jevTestConnection(): Promise<TestConnectionReport> {
  return invokeCommand<TestConnectionReport>("jev_test_connection");
}

/**
 * Hand the FINAL transcript to Jev. Fire-and-forget: the outcome
 * arrives as `jev:result` / `jev:error` events.
 * Never call this with partial transcripts.
 */
export async function processVoiceCommand(text: string): Promise<void> {
  await invokeCommand("process_voice_command", { text });
}

// ---------------------------------------------------------------------------
// Nila's response layer
// ---------------------------------------------------------------------------

type ResponseKey = keyof Dict["jev"]["responses"];

/**
 * Turn a machine-readable Jev result into Nila's user-facing message.
 * Unknown keys degrade to the generic "unknown command" line — the UI
 * never renders a raw key.
 */
export function jevResponse(
  key: string,
  params: Record<string, unknown> | undefined,
  t: Dict,
): string {
  const responses = t.jev.responses as Record<string, string>;
  let template: string | undefined = (responses as Record<string, string>)[key];

  // batteryStatus carries a `discharging` flag; pick the right template.
  if (key === "batteryStatus" && params && params.discharging === false) {
    template = responses.batteryCharging;
  }
  if (!template) template = responses.unknownCommand;

  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const v = params?.[name];
    return v === undefined || v === null ? `{${name}}` : String(v);
  });
}

/** Human label for a test-connection status. */
export function testStatusLabel(status: TestConnectionStatus, t: Dict): string {
  switch (status) {
    case "connected":
      return t.jev.testConnected;
    case "invalid_token":
      return t.jev.testInvalidToken;
    case "network_error":
      return t.jev.testNetworkError;
    case "service_unavailable":
      return t.jev.testServiceUnavailable;
    case "not_configured":
      return t.jev.notConfigured;
  }
}

export type { ResponseKey };
