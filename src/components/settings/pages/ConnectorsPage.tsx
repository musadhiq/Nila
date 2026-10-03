/**
 * Settings → Connectors → Google Calendar.
 *
 * States mirror the backend `GcalStatus.state`:
 *   disconnected → client-ID setup (first run) or [Connect]
 *   connecting   → "Connecting…" while the browser flow runs
 *   connected    → account line + test/disconnect + reminder settings
 *   auth_required→ "needs reconnection" + [Connect]
 *   error        → error line + [Connect]
 *
 * Security: only the OAuth *client ID* (public by design) is handled
 * here as plain settings text. Tokens live in the OS keychain and
 * never cross this UI.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri, listenEvent } from "../../../lib/tauri";
import {
  GCAL_EVENTS,
  gcalDisconnect,
  gcalGetStatus,
  gcalSetClientId,
  gcalStartAuth,
  gcalSyncNow,
  gcalTestConnection,
  type GcalStatus,
  type GcalTestStatus,
} from "../../../lib/calendar";
import { fill } from "../../../lib/i18n";
import { SettingsRow, SettingsSection, Select, Switch } from "../ui";
import { IconGoogleCalendar } from "../icons";
import type { PageProps } from "./page";

const MINUTE_OPTIONS = [5, 10, 15, 30, 60];

function testLabel(status: GcalTestStatus, t: PageProps["t"]): string {
  const c = t.calendar;
  switch (status) {
    case "connected":
      return c.testConnected;
    case "auth_required":
      return c.testAuthRequired;
    case "network_error":
      return c.testNetworkError;
    case "service_unavailable":
      return c.testServiceUnavailable;
    case "not_configured":
      return c.testNotConfigured;
  }
}

export function ConnectorsPage({ t, settings, update }: PageProps) {
  const c = t.calendar;
  const [status, setStatus] = useState<GcalStatus | null>(null);
  const [clientId, setClientId] = useState(settings.gcal_client_id ?? "");
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<GcalTestStatus | null>(null);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const s = await gcalGetStatus();
      if (alive.current) setStatus(s);
    } catch {
      /* stay on the last known status */
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const off = listenEvent<GcalStatus>(GCAL_EVENTS.status, (s) => {
      if (alive.current) setStatus(s);
    });
    return () => {
      alive.current = false;
      off.then((f) => f()).catch(() => {});
    };
  }, [refresh]);

  // Connector settings are written through the shared settings
  // command; the backend reacts to `gcal_*` changes atomically in
  // that same call (see `update_settings`), so no separate
  // "settings changed" round-trip is needed here — and a separate
  // call could otherwise race the write. The status card refreshes
  // from the `gcal:status` event the backend emits.
  const onSaveClientId = async () => {
    const value = clientId.trim();
    if (!value || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      await gcalSetClientId(value);
      update({ gcal_client_id: value });
      if (alive.current) setNotice({ text: c.clientIdSaved, ok: true });
    } catch {
      if (alive.current) setNotice({ text: c.clientIdInvalid, ok: false });
    } finally {
      if (alive.current) setBusy(false);
      void refresh();
    }
  };

  const onConnect = async () => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    setTestResult(null);
    try {
      await gcalStartAuth();
    } catch (e) {
      if (alive.current)
        setNotice({
          text: fill(c.authFailed, { error: e instanceof Error ? e.message : String(e) }),
          ok: false,
        });
    } finally {
      if (alive.current) setBusy(false);
      void refresh();
    }
  };

  const onDisconnect = async () => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      await gcalDisconnect();
      if (alive.current) {
        setNotice({ text: c.disconnected, ok: true });
        setTestResult(null);
      }
    } catch {
      /* status event carries the truth */
    } finally {
      if (alive.current) setBusy(false);
      void refresh();
    }
  };

  const onTest = async () => {
    if (busy) return;
    setBusy(true);
    setTestResult(null);
    try {
      const r = await gcalTestConnection();
      if (alive.current) setTestResult(r.status);
    } catch {
      if (alive.current) setTestResult("network_error");
    } finally {
      if (alive.current) setBusy(false);
      void refresh();
    }
  };

  const state = status?.state ?? "disconnected";
  const hasClientId = (settings.gcal_client_id ?? "").trim().length > 0;
  const connected = state === "connected";

  const statusLine = (() => {
    switch (state) {
      case "connected":
        return status?.email ? fill(c.connectedAs, { email: status.email }) : c.statusConnected;
      case "connecting":
        return c.statusConnecting;
      case "auth_required":
        return c.statusAuthRequired;
      case "error":
        return status?.last_error ?? c.statusError;
      default:
        return c.statusDisconnected;
    }
  })();

  return (
    <div className="settings-content-inner">
      <SettingsSection title={c.title} description={c.subtitle} icon={<IconGoogleCalendar />}>
        <SettingsRow
          title={c.title}
          description={statusLine}
          control={
            state === "disconnected" || state === "auth_required" || state === "error" ? (
              <button
                type="button"
                className="btn primary"
                disabled={busy || !isTauri() || !hasClientId}
                onClick={() => void onConnect()}
              >
                {c.connect}
              </button>
            ) : state === "connecting" ? (
              <span className="status-line">{c.connecting}</span>
            ) : undefined
          }
        />

        {!hasClientId && (
          <div className="sgroup-pad">
            <label className="field-label" htmlFor="gcal-client-id">
              {c.clientIdLabel}
            </label>
            <input
              id="gcal-client-id"
              type="text"
              className="text-input"
              autoComplete="off"
              spellCheck={false}
              placeholder={c.clientIdPlaceholder}
              value={clientId}
              disabled={busy}
              onChange={(e) => setClientId(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void onSaveClientId();
              }}
            />
            <p className="status-line" style={{ marginTop: 8 }}>{c.clientIdDesc}</p>
            <p className="status-line" style={{ marginTop: 8 }}>{c.clientIdHelp}</p>
            <div className="btn-row" style={{ marginTop: 10 }}>
              <button
                type="button"
                className="btn primary"
                disabled={busy || clientId.trim().length === 0}
                onClick={() => void onSaveClientId()}
              >
                {c.saveClientId}
              </button>
            </div>
          </div>
        )}

        {state === "auth_required" && (
          <div className="sgroup-pad">
            <p className="status-line err">{c.authRequired}</p>
          </div>
        )}

        {connected && (
          <>
            <SettingsRow
              title={c.testConnection}
              description={
                status?.last_sync ? fill(c.lastSync, { time: status.last_sync }) : "—"
              }
              control={
                <span className="btn-row">
                  <button type="button" className="btn" disabled={busy} onClick={() => void gcalSyncNow()}>
                    {c.syncNow}
                  </button>
                  <button type="button" className="btn" disabled={busy} onClick={() => void onTest()}>
                    {busy ? c.testing : c.testConnection}
                  </button>
                  <button
                    type="button"
                    className="btn danger-quiet"
                    disabled={busy}
                    onClick={() => void onDisconnect()}
                  >
                    {c.disconnect}
                  </button>
                </span>
              }
            />
            <div className="sgroup-pad">
              <p className="status-line">{c.securityNote}</p>
            </div>
          </>
        )}

        {(testResult || notice) && (
          <div className="sgroup-pad">
            {testResult && (
              <p
                className={`status-line${testResult === "connected" ? " ok" : " err"}`}
                role="status"
              >
                {testLabel(testResult, t)}
              </p>
            )}
            {notice && (
              <p className={`status-line${notice.ok ? " ok" : " err"}`} role="status">
                {notice.text}
              </p>
            )}
          </div>
        )}
      </SettingsSection>

      {connected && (
        <SettingsSection title={c.remindersEnabled}>
          <SettingsRow
            title={c.remindersEnabled}
            description={c.remindersDesc}
            control={
              <Switch
                checked={settings.gcal_reminders_enabled}
                onChange={(v) => {
                  update({ gcal_reminders_enabled: v });
                  void refresh();
                }}
                label={c.remindersEnabled}
              />
            }
          />
          <SettingsRow
            title={c.reminderMinutes}
            description={fill(c.minutesBefore, { count: settings.gcal_reminder_minutes })}
            control={
              <Select
                label={c.reminderMinutes}
                value={String(settings.gcal_reminder_minutes)}
                options={MINUTE_OPTIONS.map((m) => ({
                  value: String(m),
                  label: fill(c.minutesBefore, { count: m }),
                }))}
                onChange={(v) => {
                  update({ gcal_reminder_minutes: Number(v) });
                  void refresh();
                }}
              />
            }
          />
          <SettingsRow
            title={c.alldayLabel}
            description={c.alldayDesc}
            control={
              <Switch
                checked={settings.gcal_allday_reminders_enabled}
                onChange={(v) => {
                  update({ gcal_allday_reminders_enabled: v });
                  void refresh();
                }}
                label={c.alldayLabel}
              />
            }
          />
        </SettingsSection>
      )}
    </div>
  );
}
