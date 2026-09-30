/**
 * Schedule page — quiet hours, daily limit, cooldown. Human descriptions;
 * no scheduler internals.
 */
import { fill } from "../../../lib/i18n";
import { SettingsRow, SettingsSection, Slider } from "../ui";
import type { PageProps } from "./page";

export function SchedulePage({ t, settings, update }: PageProps) {
  const s = t.schedule;
  return (
    <div className="settings-content-inner">
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
      </SettingsSection>

      <SettingsSection title={s.limitSection}>
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
      </SettingsSection>

      <SettingsSection title={s.cooldownSection}>
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
    </div>
  );
}
