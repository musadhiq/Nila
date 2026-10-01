/**
 * Welcome page — the friendly landing page, and the first-run setup flow.
 *
 * In setup mode (first launch) it shows a "Get started" button that marks
 * setup complete; afterwards it is a normal sidebar page.
 */
import { SettingsSection } from "../ui";
import type { PageProps } from "./page";
import logoUrl from "../../../../character/nila-logo.png";

interface WelcomeProps extends PageProps {
  /** First-run flow: show the finish button. */
  setupMode?: boolean;
  /** Called when the user finishes the first-run setup. */
  onFinishSetup?: () => void;
}

export function WelcomePage({ t, setupMode, onFinishSetup }: WelcomeProps) {
  const w = t.welcome;
  const steps = [
    { n: "1", title: w.step1Title, text: w.step1Text },
    { n: "2", title: w.step2Title, text: w.step2Text },
    { n: "3", title: w.step3Title, text: w.step3Text },
  ];
  return (
    <div className="settings-content-inner">
      <div className="welcome-hero">
        <img src={logoUrl} alt="Nila" draggable={false} />
        <p className="about-tagline">{w.tagline}</p>
      </div>

      <SettingsSection title={t.nav.welcome}>
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
      </SettingsSection>

      {setupMode && (
        <div className="welcome-cta">
          <button
            type="button"
            className="btn primary"
            onClick={() => onFinishSetup?.()}
          >
            {w.getStarted}
          </button>
        </div>
      )}
    </div>
  );
}
