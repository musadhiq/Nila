import { useState } from "react";
import { ACTIONS, SETTINGS_LABELS } from "../lib/strings";
import type { AppSettings } from "../lib/types";

interface Props {
  settings: AppSettings;
  paused: boolean;
  onSave: (s: AppSettings) => void;
  onPause: (minutes: 30 | 60 | null) => void;
  onResume: () => void;
  onTest: () => void;
  onClose: () => void;
}

/** SettingsPanel — quiet hours, limits, character, pause, test (Phase 10). */
export function SettingsPanel({ settings, paused, onSave, onPause, onResume, onTest, onClose }: Props) {
  const [draft, setDraft] = useState<AppSettings>({ ...settings });
  const set = <K extends keyof AppSettings>(k: K, v: AppSettings[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

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
        <span>{SETTINGS_LABELS.cooldown} (മിനിറ്റ്)</span>
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

      <div className="panel-actions">
        <button type="button" className="btn primary" onClick={() => onSave(draft)}>
          {ACTIONS.save}
        </button>
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
