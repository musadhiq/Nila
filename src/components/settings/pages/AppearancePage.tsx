/**
 * Appearance page — theme and a restrained set of Nila accent colors.
 */
import { SettingsRow, SettingsSection, Segmented } from "../ui";
import { IconCheck } from "../icons";
import type { PageProps } from "./page";
import type { AppSettings } from "../../../lib/types";

const ACCENTS: { value: AppSettings["accent"]; color: string; sw: string }[] = [
  { value: "teal", color: "#0d9488", sw: "rgba(13,148,136,0.16)" },
  { value: "amber", color: "#d97706", sw: "rgba(217,119,6,0.16)" },
  { value: "rose", color: "#e11d48", sw: "rgba(225,29,72,0.14)" },
  { value: "indigo", color: "#6366f1", sw: "rgba(99,102,241,0.16)" },
];

export function AppearancePage({ t, settings, update }: PageProps) {
  const a = t.appearance;
  const accentLabel: Record<AppSettings["accent"], string> = {
    teal: a.accentTeal,
    amber: a.accentAmber,
    rose: a.accentRose,
    indigo: a.accentIndigo,
  };
  return (
    <div className="settings-content-inner">
      <SettingsSection title={a.themeSection}>
        <SettingsRow
          title={a.themeSection}
          description={a.themeDesc}
          control={
            <Segmented
              label={a.themeSection}
              value={settings.appearance}
              onChange={(v) => update({ appearance: v })}
              options={[
                { value: "system", label: a.themeSystem },
                { value: "light", label: a.themeLight },
                { value: "dark", label: a.themeDark },
              ]}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title={a.accentSection}>
        <SettingsRow
          title={a.accentSection}
          description={a.accentDesc}
          control={
            <span
              className="swatches"
              role="radiogroup"
              aria-label={a.accentSection}
            >
              {ACCENTS.map((acc) => (
                <button
                  key={acc.value}
                  type="button"
                  role="radio"
                  aria-checked={settings.accent === acc.value}
                  aria-label={accentLabel[acc.value]}
                  title={accentLabel[acc.value]}
                  className="swatch"
                  style={
                    {
                      background: acc.color,
                      "--sw": acc.color,
                    } as React.CSSProperties
                  }
                  onClick={() =>
                    update({
                      accent: acc.value,
                    })
                  }
                >
                  {settings.accent === acc.value && <IconCheck />}
                </button>
              ))}
            </span>
          }
        />
      </SettingsSection>
    </div>
  );
}
