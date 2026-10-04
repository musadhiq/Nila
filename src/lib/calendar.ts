/**
 * Google Calendar connector — frontend side.
 *
 * The connector itself lives in Rust
 * (connectors/google_calendar). This module is the thin bridge:
 * Tauri commands for Settings → Connectors → Google Calendar and
 * the `gcal:*` event contract.
 *
 * No OAuth: the connector reads the calendar's private ICS feed
 * ("Secret address in iCal format"). The feed URL is a bearer
 * credential and is NEVER handled here — it is stored and fetched
 * entirely in Rust (OS keychain).
 */

import { invokeCommand } from "./tauri.ts";

export const GCAL_EVENTS = {
  status: "gcal:status",
  sync: "gcal:sync",
} as const;

export type GcalState = "disconnected" | "connected" | "error";

export interface GcalStatus {
  state: GcalState;
  calendar_name: string | null;
  last_sync: string | null;
  last_error: string | null;
}

export type GcalTestStatus =
  | "connected"
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

/**
 * Save the calendar's private ICS feed URL ("Secret address in iCal
 * format"). The URL goes straight to the OS keychain; the frontend
 * never sees it again.
 */
export async function gcalSetFeedUrl(url: string): Promise<void> {
  await invokeCommand("gcal_set_feed_url", { url });
}

/** Remove the feed URL, stop polling, delete calendar reminders. */
export async function gcalDisconnect(): Promise<void> {
  await invokeCommand("gcal_disconnect");
}

/** Fetch the feed once and report. */
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
