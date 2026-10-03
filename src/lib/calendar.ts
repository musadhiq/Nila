/**
 * Google Calendar connector — frontend side.
 *
 * The connector itself lives in Rust
 * (connectors/google_calendar). This module is the thin bridge:
 * Tauri commands for Settings → Connectors → Google Calendar and
 * the `gcal:*` event contract.
 *
 * Tokens are NEVER handled here — the OAuth flow, storage, and
 * refresh all stay in Rust. The client ID is plain settings text.
 */

import { invokeCommand } from "./tauri.ts";

export const GCAL_EVENTS = {
  status: "gcal:status",
  sync: "gcal:sync",
} as const;

export type GcalState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "auth_required"
  | "error";

export interface GcalStatus {
  state: GcalState;
  email: string | null;
  last_sync: string | null;
  last_error: string | null;
}

export type GcalTestStatus =
  | "connected"
  | "auth_required"
  | "network_error"
  | "service_unavailable"
  | "not_configured";

export interface GcalTestReport {
  status: GcalTestStatus;
}

/** Status for Settings → Connectors → Google Calendar. */
export async function gcalGetStatus(): Promise<GcalStatus> {
  return invokeCommand<GcalStatus>("gcal_get_status");
}

/** Save the user's Google OAuth client ID (plain settings). */
export async function gcalSetClientId(clientId: string): Promise<void> {
  await invokeCommand("gcal_set_client_id", { clientId });
}

/**
 * Begin the browser OAuth flow. Returns immediately; progress
 * arrives as `gcal:status` events.
 */
export async function gcalStartAuth(): Promise<void> {
  await invokeCommand("gcal_start_auth");
}

/** Remove tokens, stop polling, delete calendar reminders. */
export async function gcalDisconnect(): Promise<void> {
  await invokeCommand("gcal_disconnect");
}

/** Lightweight authenticated probe. */
export async function gcalTestConnection(): Promise<GcalTestReport> {
  return invokeCommand<GcalTestReport>("gcal_test_connection");
}

/**
 * Tell the backend the gcal_* settings changed: it (re)starts or
 * stops the poll task and wakes it for an immediate resync.
 */
export async function gcalSettingsChanged(): Promise<void> {
  await invokeCommand("gcal_settings_changed");
}

/** Wake the poll task for an immediate sync. */
export async function gcalSyncNow(): Promise<void> {
  await invokeCommand("gcal_sync_now");
}
