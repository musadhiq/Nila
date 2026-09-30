/**
 * About page — minimal: Nila, version, tagline, links.
 */
import { fill } from "../../../lib/i18n";
import { SettingsRow, SettingsSection } from "../ui";
import type { PageProps } from "./page";
import idleUrl from "../../../../character/states/idle.png";

const NILA_VERSION = "0.1.0";

export function AboutPage({ t }: PageProps) {
  const a = t.about;
  return (
    <div className="settings-content-inner">
      <div className="about-hero">
        <img src={idleUrl} alt="Nila" draggable={false} />
        <span className="about-name">Nila</span>
        <span className="about-version">
          {fill(a.version, { version: NILA_VERSION })}
        </span>
        <p className="about-tagline">{a.tagline}</p>
      </div>

      <SettingsSection title="Nila">
        <SettingsRow
          title={a.versionLabel}
          control={<span className="mono">{NILA_VERSION}</span>}
        />
        <SettingsRow
          title={a.documentation}
          control={<span className="mono">{a.documentationValue}</span>}
        />
        <SettingsRow
          title={a.licenses}
          control={<span className="mono">{a.licensesValue}</span>}
        />
        <SettingsRow
          title={a.github}
          control={<span className="mono">{a.githubValue}</span>}
        />
        <SettingsRow title={a.madeFor} />
      </SettingsSection>
    </div>
  );
}
