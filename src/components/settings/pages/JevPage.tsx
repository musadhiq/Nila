/**
 * Settings → AI / Jev — Jev API token configuration.
 *
 * States mirror the spec:
 *   not configured → "Jev / Not configured" + intro + [Add Token]
 *   adding         → password field + [Save] [Cancel]
 *   configured     → "Jev / Connected" + masked token + [Test Connection] [Remove]
 *
 * Security: the raw token lives only in this component's state while
 * the form is open. It is never written to localStorage/IndexedDB/
 * settings JSON, and after saving the input is cleared immediately.
 * The backend never returns the token — status only.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "../../../lib/tauri";
import {
  jevGetStatus,
  jevRemoveToken,
  jevSetToken,
  jevTestConnection,
  testStatusLabel,
  type JevStatus,
  type TestConnectionStatus,
} from "../../../lib/jev";
import { SettingsRow, SettingsSection } from "../ui";
import type { PageProps } from "./page";

type Phase = "checking" | "missing" | "adding" | "ready";

export function JevPage({ t }: PageProps) {
  const j = t.jev;
  const [phase, setPhase] = useState<Phase>("checking");
  const [status, setStatus] = useState<JevStatus>({ configured: false, connected: false });
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<TestConnectionStatus | null>(null);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const s = await jevGetStatus();
      if (!alive.current) return;
      setStatus(s);
      setPhase(s.configured ? "ready" : "missing");
    } catch {
      if (alive.current) setPhase("missing");
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => {
      alive.current = false;
    };
  }, [refresh]);

  // The token must not linger in memory: clear it whenever we leave
  // the "adding" phase.
  const clearToken = () => setToken("");

  const onSave = async () => {
    const value = token.trim();
    if (!value || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      await jevSetToken(value);
      if (!alive.current) return;
      setNotice({ text: j.tokenSaved, ok: true });
      setTestResult(null);
      setPhase("checking");
      await refresh();
    } catch {
      if (alive.current) setNotice({ text: j.setFailed, ok: false });
    } finally {
      clearToken();
      if (alive.current) setBusy(false);
    }
  };

  const onRemove = async () => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      await jevRemoveToken();
      if (!alive.current) return;
      setNotice({ text: j.tokenRemoved, ok: true });
      setTestResult(null);
    } catch {
      if (alive.current) setNotice({ text: j.removeFailed, ok: false });
    } finally {
      if (alive.current) {
        setBusy(false);
        setPhase("checking");
        void refresh();
      }
    }
  };

  const onTest = async () => {
    if (busy) return;
    setBusy(true);
    setTestResult(null);
    try {
      const r = await jevTestConnection();
      if (alive.current) setTestResult(r.status);
    } catch {
      if (alive.current) setTestResult("network_error");
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const statusLine =
    phase === "checking" ? "…" : status.connected ? j.connected : j.notConfigured;

  return (
    <div className="settings-content-inner">
      <SettingsSection title={j.title}>
        <SettingsRow
          title={j.title}
          description={statusLine}
          control={
            phase === "missing" ? (
              <button
                type="button"
                className="btn"
                disabled={!isTauri()}
                onClick={() => {
                  clearToken();
                  setNotice(null);
                  setPhase("adding");
                }}
              >
                {j.addToken}
              </button>
            ) : undefined
          }
        />

        {phase === "missing" && <p className="status-line">{j.intro}</p>}

        {phase === "adding" && (
          <>
            <div className="srow">
              <span className="srow-text">
                <label className="srow-title" htmlFor="jev-token">
                  {j.tokenLabel}
                </label>
              </span>
            </div>
            <input
              id="jev-token"
              type="password"
              className="text-input"
              autoComplete="off"
              spellCheck={false}
              placeholder={j.tokenPlaceholder}
              value={token}
              disabled={busy}
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void onSave();
                if (e.key === "Escape") {
                  clearToken();
                  setPhase("missing");
                }
              }}
            />
            <div className="btn-row" style={{ marginTop: 10 }}>
              <button
                type="button"
                className="btn primary"
                disabled={busy || token.trim().length === 0}
                onClick={() => void onSave()}
              >
                {busy ? j.saving : j.save}
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => {
                  clearToken();
                  setPhase("missing");
                }}
              >
                {j.cancel}
              </button>
            </div>
          </>
        )}

        {phase === "ready" && (
          <>
            <SettingsRow
              title={j.tokenLabel}
              description={j.maskedToken}
              control={
                <span className="btn-row">
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => void onTest()}
                  >
                    {busy ? j.testing : j.testConnection}
                  </button>
                  <button
                    type="button"
                    className="btn danger-quiet"
                    disabled={busy}
                    onClick={() => void onRemove()}
                  >
                    {busy ? j.removing : j.remove}
                  </button>
                </span>
              }
            />
            <p className="status-line">{j.securityNote}</p>
          </>
        )}

        {testResult && (
          <p
            className={`status-line${testResult === "connected" ? " ok" : " err"}`}
            role="status"
          >
            {testStatusLabel(testResult, t)}
          </p>
        )}
        {notice && (
          <p className={`status-line${notice.ok ? " ok" : " err"}`} role="status">
            {notice.text}
          </p>
        )}
      </SettingsSection>
    </div>
  );
}
