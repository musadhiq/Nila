/**
 * General page — Nila behavior, pause, try-it-out, backup.
 * Every control applies immediately; there is no Save button.
 */
import { useRef, useState } from "react";
import { enable, disable } from "@tauri-apps/plugin-autostart";
import { fill, type Dict, type Language } from "../../../lib/i18n";
import { invokeCommand, isTauri } from "../../../lib/tauri";
import type { AppSettings } from "../../../lib/types";
import type { ExpressionName } from "../../../character/expressions";
import { SettingsRow, SettingsSection, Slider, Switch } from "../ui";

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
  const l = t.languagePage;
  const s = t.schedule;
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

  /**
   * Start-at-login toggle: persist the preference AND apply it to the OS
   * immediately via the autostart plugin. The backend also re-syncs this
   * setting on every launch, so the two can never drift apart.
   */
  const onToggleAutostart = (v: boolean) => {
    update({ start_at_login: v });
    if (!isTauri()) return;
    void (v ? enable() : disable()).catch(() => {
      /* backend re-syncs on next launch */
    });
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
              onChange={(v) => onToggleAutostart(v)}
              label={g.startAtLogin}
            />
          }
        />
        <SettingsRow
          title={g.wakeWord}
          description={g.wakeWordDesc}
          control={
            <Switch
              checked={settings.wake_word_enabled}
              onChange={(v) => update({ wake_word_enabled: v })}
              label={g.wakeWord}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title={l.section}>
        {(["en", "manglish"] as Language[]).map((opt) => (
          <SettingsRow
            key={opt}
            title={opt === "en" ? l.english : l.manglish}
            description={opt === "en" ? l.englishDesc : l.manglishDesc}
            onActivate={() => update({ language: opt })}
            control={
              <span role="radio" aria-checked={settings.language === opt}>
                <span className="radio-dot" />
              </span>
            }
          />
        ))}
      </SettingsSection>

      <SettingsSection title={s.quietSection}>
        <SettingsRow
          title={s.quietSection}
          description={s.quietDesc}
          control={
            <span className="inline-row" style={{ minWidth: 220 }}>
              <input
                type="time"
                className="time-input"
                value={settings.quiet_start}
                aria-label={s.quietStart}
                onChange={(e) => update({ quiet_start: e.target.value })}
              />
              <input
                type="time"
                className="time-input"
                value={settings.quiet_end}
                aria-label={s.quietEnd}
                onChange={(e) => update({ quiet_end: e.target.value })}
              />
            </span>
          }
        />
        <SettingsRow
          title={s.limitSection}
          description={s.limitDesc}
          control={
            <Slider
              label={s.limitSection}
              value={settings.daily_limit}
              min={1}
              max={48}
              onChange={(v) => update({ daily_limit: v })}
              format={(v) => fill(s.limitValue, { count: v })}
            />
          }
        />
        <SettingsRow
          title={s.cooldownSection}
          description={s.cooldownDesc}
          control={
            <Slider
              label={s.cooldownSection}
              value={settings.cooldown_minutes}
              min={0}
              max={240}
              step={5}
              onChange={(v) => update({ cooldown_minutes: v })}
              format={(v) => fill(s.cooldownValue, { count: v })}
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
        {status && (
          <div className="sgroup-pad">
            <p
              className={`status-line${status.ok ? " ok" : " err"}`}
              role="status"
            >
              {status.text}
            </p>
          </div>
        )}
      </SettingsSection>
    </div>
  );
}
