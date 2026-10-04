/**
 * Settings → Connectors → Google Calendar.
 *
 * No OAuth: the connector reads the calendar's private ICS feed
 * ("Secret address in iCal format"). The user pastes the URL once;
 * it goes straight to the OS keychain via `gcal_set_feed_url` and the
 * frontend never sees it again.
 *
 * States mirror the backend `GcalStatus.state`:
 *   disconnected → feed-URL setup (first run)
 *   connected    → calendar line + test/sync/disconnect + reminder settings
 *   error        → error line + setup
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri, listenEvent } from "../../../lib/tauri";
import {
  GCAL_EVENTS,
  gcalDisconnect,
  gcalGetStatus,
  gcalSetFeedUrl,
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
  const [feedUrl, setFeedUrl] = useState("");
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

  // The feed URL is a bearer credential: it is validated and stored
  // in the OS keychain by the backend in the same IPC call, so the
  // frontend never retains it beyond this form.
  const onSaveFeedUrl = async () => {
    const value = feedUrl.trim();
    if (!value || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      await gcalSetFeedUrl(value);
      if (alive.current) {
        setFeedUrl("");
        setNotice({ text: c.feedUrlSaved, ok: true });
      }
    } catch {
      if (alive.current) setNotice({ text: c.feedUrlInvalid, ok: false });
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
  const connected = state === "connected";

  const statusLine = (() => {
    switch (state) {
      case "connected":
        return status?.calendar_name
          ? fill(c.connectedAs, { name: status.calendar_name })
          : c.statusConnected;
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
            state === "error" ? (
              <button
                type="button"
                className="btn primary"
                disabled={busy || !isTauri()}
                onClick={() => void onTest()}
              >
                {busy ? c.testing : c.testConnection}
              </button>
            ) : undefined
          }
        />

        {!connected && (
          <div className="sgroup-pad">
            <p className="status-line" style={{ marginBottom: 10 }}>{c.feedUrlDesc}</p>
            <label className="field-label" htmlFor="gcal-feed-url">
              {c.feedUrlLabel}
            </label>
            <input
              id="gcal-feed-url"
              type="password"
              className="text-input"
              autoComplete="off"
              spellCheck={false}
              placeholder={c.feedUrlPlaceholder}
              value={feedUrl}
              disabled={busy}
              onChange={(e) => setFeedUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void onSaveFeedUrl();
              }}
            />
            <p className="status-line" style={{ marginTop: 8 }}>{c.feedUrlHelp}</p>
            <div className="btn-row" style={{ marginTop: 10 }}>
              <button
                type="button"
                className="btn primary"
                disabled={busy || feedUrl.trim().length === 0}
                onClick={() => void onSaveFeedUrl()}
              >
                {c.saveFeedUrl}
              </button>
            </div>
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
