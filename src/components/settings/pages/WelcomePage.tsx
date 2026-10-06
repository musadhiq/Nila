/**
 * Welcome page — the friendly first-run onboarding, and a replays-later
 * tour. Short by design: character, intro, three steps, language, two
 * actions. No settings firehose.
 *
 * In setup mode (first launch) it shows "Create your first reminder" and
 * "Continue". Afterwards it is a calm tour page with no finish button.
 */
import { NilaMascot } from "../../../mascot/NilaMascot";
import nilaDirectionsUrl from "../../../../character/mascot/nila-directions.webp";
import nilaReactionsUrl from "../../../../character/mascot/nila-reactions.webp";
import type { Language } from "../../../lib/i18n";
import { Segmented } from "../ui";
import type { PageProps } from "./page";

interface WelcomeProps extends PageProps {
  /** First-run flow: show the onboarding actions. */
  setupMode?: boolean;
  /** Called when the user finishes the first-run setup. */
  onFinishSetup?: () => void;
  /** Jump to the reminders page with the editor open. */
  onCreateFirstReminder?: () => void;
}

export function WelcomePage({
  t,
  settings,
  update,
  setupMode,
  onFinishSetup,
  onCreateFirstReminder,
}: WelcomeProps) {
  const w = t.welcome;
  const l = t.languagePage;
  const steps = [
    { n: "1", title: w.step1Title, text: w.step1Text },
    { n: "2", title: w.step2Title, text: w.step2Text },
    { n: "3", title: w.step3Title, text: w.step3Text },
  ];
  return (
    <div className="settings-content-inner welcome-onboard">
      <div className="welcome-hero">
        <NilaMascot
          directions={nilaDirectionsUrl}
          reactions={nilaReactionsUrl}
          size={120}
          label="Nila"
          reaction={0}
          className="welcome-face"
        />
        <h2 className="welcome-headline">{w.headline}</h2>
        <p className="welcome-intro">{w.intro}</p>
      </div>

      <div className="welcome-steps">
        {steps.map((s) => (
          <div className="welcome-step" key={s.n}>
            <span className="welcome-num" aria-hidden="true">
              {s.n}
            </span>
            <span className="welcome-step-body">
              <span className="welcome-step-title">{s.title}</span>
              <span className="welcome-step-text">{s.text}</span>
            </span>
          </div>
        ))}
      </div>

      <div className="welcome-lang">
        <span className="welcome-lang-label" id="welcome-lang-label">
          {w.languageLabel}
        </span>
        <Segmented<Language>
          label={w.languageLabel}
          value={settings.language}
          onChange={(v) => update({ language: v })}
          options={[
            { value: "en", label: l.english },
            { value: "manglish", label: l.manglish },
          ]}
        />
      </div>

      {setupMode && (
        <div className="welcome-cta">
          <button
            type="button"
            className="btn"
            onClick={() => onCreateFirstReminder?.()}
          >
            {w.createFirst}
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => onFinishSetup?.()}
          >
            {w.continue}
          </button>
        </div>
      )}
    </div>
  );
}
