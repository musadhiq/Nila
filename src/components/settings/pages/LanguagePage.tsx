/**
 * Language page — English / Manglish. Applies immediately, no restart.
 */
import { SettingsRow, SettingsSection } from "../ui";
import type { PageProps } from "./page";
import type { Language } from "../../../lib/i18n";

const OPTIONS: Language[] = ["en", "manglish"];

export function LanguagePage({ t, settings, update }: PageProps) {
  const l = t.languagePage;
  const meta: Record<Language, { title: string; desc: string }> = {
    en: { title: l.english, desc: l.englishDesc },
    manglish: { title: l.manglish, desc: l.manglishDesc },
  };
  return (
    <div className="settings-content-inner">
      <SettingsSection title={l.section}>
        {OPTIONS.map((opt) => (
          <SettingsRow
            key={opt}
            title={meta[opt].title}
            description={meta[opt].desc}
            onActivate={() => update({ language: opt })}
            control={
              <span role="radio" aria-checked={settings.language === opt}>
                <span className="radio-dot" />
              </span>
            }
          />
        ))}
      </SettingsSection>
      <p className="status-line">{l.sectionDesc}</p>
    </div>
  );
}
