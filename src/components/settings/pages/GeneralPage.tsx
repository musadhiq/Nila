/**
 * General page — Nila behavior, pause, try-it-out, backup.
 * Every control applies immediately; there is no Save button.
 */
import { useRef, useState } from "react";
import { fill, type Dict } from "../../../lib/i18n";
import { invokeCommand, isTauri } from "../../../lib/tauri";
import type { AppSettings } from "../../../lib/types";
import type { ExpressionName } from "../../../character/expressions";
import { SettingsRow, SettingsSection, Switch } from "../ui";

interface Props {
  t: Dict;
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
  paused: boolean;
  pausedUntil: string;
  onPause: (minutes: 30 | 60 | null) => void;
  onResume: () => void;
  onTest: () => void;
  onDataChanged: () => void;
  onFlash?: (name: ExpressionName) => void;
}

export function GeneralPage({
  t,
  settings,
  update,
  paused,
  pausedUntil,
  onPause,
  onResume,
  onTest,
  onDataChanged,
  onFlash,
}: Props) {
  const g = t.general;
  const fileRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const backendAvailable = isTauri();

  const errText = (e: unknown, fallback: string): string =>
    typeof e === "string" ? e : e instanceof Error ? e.message : fallback;

  const doExport = async () => {
    setStatus(null);
    setBusy(true);
    try {
      const data = await invokeCommand<unknown>("export_data");
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `nila-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 5000);
      setStatus({ ok: true, text: g.exported });
    } catch (e) {
      setStatus({ ok: false, text: errText(e, t.errors.exportFailed) });
    } finally {
      setBusy(false);
    }
  };

  const doImport = async (file: File) => {
    setStatus(null);
    setBusy(true);
    try {
      let data: unknown;
      try {
        data = JSON.parse(await file.text());
      } catch {
        onFlash?.("confused");
        setStatus({ ok: false, text: t.errors.importInvalid });
        return;
      }
      const count = await invokeCommand<number>("import_data", { data });
      onDataChanged();
      setStatus({ ok: true, text: fill(g.imported, { count }) });
    } catch (e) {
      onFlash?.("confused");
      setStatus({ ok: false, text: errText(e, t.errors.importFailed) });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const pausedLabel = (() => {
    if (!paused || !pausedUntil) return null;
    const d = new Date(pausedUntil);
    if (Number.isNaN(d.getTime())) return null;
    return fill(g.pausedUntil, {
      time: d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    });
  })();

  return (
    <div className="settings-content-inner">
      <SettingsSection title={g.behaviorSection}>
        <SettingsRow
          title={g.startAtLogin}
          description={g.startAtLoginDesc}
          control={
            <Switch
              checked={settings.start_at_login}
              onChange={(v) => update({ start_at_login: v })}
              label={g.startAtLogin}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title={g.pauseSection}>
        <SettingsRow
          title={paused ? g.resume : g.pauseSection}
          description={paused ? (pausedLabel ?? g.pauseDesc) : g.pauseDesc}
          control={
            paused ? (
              <button type="button" className="btn" onClick={onResume}>
                {g.resume}
              </button>
            ) : (
              <span className="btn-row" role="group" aria-label={g.pauseSection}>
                <button type="button" className="btn" onClick={() => onPause(30)}>
                  {g.pause30}
                </button>
                <button type="button" className="btn" onClick={() => onPause(60)}>
                  {g.pause60}
                </button>
                <button type="button" className="btn" onClick={() => onPause(null)}>
                  {g.pauseTomorrow}
                </button>
              </span>
            )
          }
        />
      </SettingsSection>

      <SettingsSection title={g.testSection}>
        <SettingsRow
          title={g.testReminder}
          description={g.testReminderDesc}
          control={
            <button type="button" className="btn" onClick={onTest}>
              {g.testReminder}
            </button>
          }
        />
      </SettingsSection>

      <SettingsSection title={g.backupSection}>
        <SettingsRow
          title={g.backupSection}
          description={g.backupDesc}
          control={
            <span className="btn-row">
              <button
                type="button"
                className="btn"
                disabled={!backendAvailable || busy}
                onClick={() => void doExport()}
              >
                {g.export}
              </button>
              <button
                type="button"
                className="btn"
                disabled={!backendAvailable || busy}
                onClick={() => fileRef.current?.click()}
              >
                {g.import}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                hidden
                aria-label={g.import}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void doImport(f);
                }}
              />
            </span>
          }
        />
      </SettingsSection>

      {status && (
        <p className={`status-line ${status.ok ? "ok" : "err"}`} role="status">
          {status.text}
        </p>
      )}
    </div>
  );
}
