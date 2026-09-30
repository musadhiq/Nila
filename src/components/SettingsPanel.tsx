import { useRef, useState } from "react";
import { ACTIONS, ERRORS, SETTINGS_LABELS } from "../lib/strings";
import { invokeCommand, isTauri } from "../lib/tauri";
import type { ExpressionName } from "../character/expressions";
import type { AppSettings } from "../lib/types";

interface Props {
  settings: AppSettings;
  paused: boolean;
  onSave: (s: AppSettings) => void;
  onPause: (minutes: 30 | 60 | null) => void;
  onResume: () => void;
  onTest: () => void;
  onClose: () => void;
  onDataChanged: () => void;
  /** Flash a momentary expression face (e.g. confused on a bad import). */
  onFlash?: (name: ExpressionName) => void;
}

interface Status {
  ok: boolean;
  text: string;
}

/** SettingsPanel — quiet hours, limits, character, appearance, sound, data, pause, test. */
export function SettingsPanel({
  settings,
  paused,
  onSave,
  onPause,
  onResume,
  onTest,
  onClose,
  onDataChanged,
  onFlash,
}: Props) {
  const [draft, setDraft] = useState<AppSettings>({ ...settings });
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const set = <K extends keyof AppSettings>(k: K, v: AppSettings[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  // Export/import need the Rust backend; in plain `vite dev` they stay disabled.
  const backendAvailable = isTauri();

  const errText = (e: unknown, fallback: string): string =>
    typeof e === "string" ? e : e instanceof Error ? e.message : fallback;

  const resetFileInput = () => {
    if (fileRef.current) fileRef.current.value = "";
  };

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
      setStatus({ ok: true, text: SETTINGS_LABELS.exported });
    } catch (e) {
      setStatus({ ok: false, text: errText(e, ERRORS.exportFailed) });
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
        setStatus({ ok: false, text: ERRORS.importInvalid });
        return;
      }
      const count = await invokeCommand<number>("import_data", { data });
      onDataChanged();
      setStatus({ ok: true, text: `${SETTINGS_LABELS.imported} (${count})` });
    } catch (e) {
      onFlash?.("confused");
      setStatus({ ok: false, text: errText(e, ERRORS.importFailed) });
    } finally {
      setBusy(false);
      resetFileInput();
    }
  };

  return (
    <div className="panel" role="dialog" aria-label={SETTINGS_LABELS.general}>
      <div className="panel-header">
        <span className="panel-title">{SETTINGS_LABELS.general}</span>
        <button type="button" className="icon-btn" onClick={onClose} aria-label={ACTIONS.cancel}>✕</button>
      </div>

      <label className="field">
        <span>{SETTINGS_LABELS.quietHours}</span>
        <span className="field-row">
          <input
            type="time"
            value={draft.quiet_start}
            onChange={(e) => set("quiet_start", e.target.value)}
            aria-label={`${SETTINGS_LABELS.quietHours} start`}
          />
          <span>–</span>
          <input
            type="time"
            value={draft.quiet_end}
            onChange={(e) => set("quiet_end", e.target.value)}
            aria-label={`${SETTINGS_LABELS.quietHours} end`}
          />
        </span>
      </label>

      <label className="field">
        <span>{SETTINGS_LABELS.dailyLimit}</span>
        <input
          type="number"
          min={1}
          max={48}
          value={draft.daily_limit}
          onChange={(e) => set("daily_limit", Math.max(1, Number(e.target.value) || 1))}
        />
      </label>

      <label className="field">
        <span>{SETTINGS_LABELS.cooldown} (minutes)</span>
        <input
          type="number"
          min={0}
          max={240}
          value={draft.cooldown_minutes}
          onChange={(e) => set("cooldown_minutes", Math.max(0, Number(e.target.value) || 0))}
        />
      </label>

      <label className="field">
        <span>{SETTINGS_LABELS.character}</span>
        <span className="field-row">
          <select value={draft.character_size} onChange={(e) => set("character_size", e.target.value as AppSettings["character_size"])}>
            <option value="small">{SETTINGS_LABELS.sizeSmall}</option>
            <option value="medium">{SETTINGS_LABELS.sizeMedium}</option>
            <option value="large">{SETTINGS_LABELS.sizeLarge}</option>
          </select>
          <select value={draft.animation} onChange={(e) => set("animation", e.target.value as AppSettings["animation"])}>
            <option value="full">{SETTINGS_LABELS.animationFull}</option>
            <option value="reduced">{SETTINGS_LABELS.animationReduced}</option>
            <option value="off">{SETTINGS_LABELS.animationOff}</option>
          </select>
        </span>
      </label>

      <label className="field">
        <span>{SETTINGS_LABELS.appearance}</span>
        <select value={draft.appearance} onChange={(e) => set("appearance", e.target.value as AppSettings["appearance"])}>
          <option value="system">{SETTINGS_LABELS.themeSystem}</option>
          <option value="light">{SETTINGS_LABELS.themeLight}</option>
          <option value="dark">{SETTINGS_LABELS.themeDark}</option>
        </select>
      </label>

      <label className="field">
        <span>{SETTINGS_LABELS.sound}</span>
        <select value={draft.sound} onChange={(e) => set("sound", e.target.value as AppSettings["sound"])}>
          <option value="none">{SETTINGS_LABELS.soundNone}</option>
          <option value="soft">{SETTINGS_LABELS.soundSoft}</option>
          <option value="chime">{SETTINGS_LABELS.soundChime}</option>
        </select>
      </label>

      <div className="panel-actions">
        <button type="button" className="btn primary" onClick={() => onSave(draft)}>
          {ACTIONS.save}
        </button>
      </div>

      <div className="panel-section">
        <span className="field">
          <span>{SETTINGS_LABELS.dataSection}</span>
        </span>
        <span className="field-row">
          <button
            type="button"
            className="btn small"
            disabled={!backendAvailable || busy}
            onClick={() => void doExport()}
          >
            {SETTINGS_LABELS.exportData}
          </button>
          <button
            type="button"
            className="btn small"
            disabled={!backendAvailable || busy}
            onClick={() => fileRef.current?.click()}
          >
            {SETTINGS_LABELS.importData}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            aria-label={SETTINGS_LABELS.importData}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void doImport(f);
            }}
          />
        </span>
        {status && (
          <p className={`status-line ${status.ok ? "ok" : "err"}`} role="status">
            {status.text}
          </p>
        )}
      </div>

      <div className="panel-section">
        {paused ? (
          <button type="button" className="btn" onClick={onResume}>{ACTIONS.resume}</button>
        ) : (
          <span className="field-row">
            <button type="button" className="btn small" onClick={() => onPause(30)}>{ACTIONS.pause30}</button>
            <button type="button" className="btn small" onClick={() => onPause(60)}>{ACTIONS.pause60}</button>
            <button type="button" className="btn small" onClick={() => onPause(null)}>{ACTIONS.pauseTomorrow}</button>
          </span>
        )}
      </div>

      <div className="panel-section">
        <button type="button" className="btn small ghost" onClick={onTest}>
          {ACTIONS.testReminder}
        </button>
      </div>
    </div>
  );
}
