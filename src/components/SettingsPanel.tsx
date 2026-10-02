/**
 * SettingsPanel — the premium two-column settings experience.
 *
 * Sidebar navigation + one page at a time. Every control applies
 * immediately (no Save button); language switching re-renders instantly.
 */
import { useEffect, useState } from "react";
import "../styles/settings.css";
import { getStrings, fill, type Language } from "../lib/i18n";
import type { AppSettings, Reminder } from "../lib/types";
import { quietHoursActive } from "../lib/reminders";
import type { ExpressionName } from "../character/expressions";
import { SettingsLayout, type PageId } from "./settings/SettingsLayout";
import { WelcomePage } from "./settings/pages/WelcomePage";
import { GeneralPage } from "./settings/pages/GeneralPage";
import { JevPage } from "./settings/pages/JevPage";
import { CommandsPage } from "./settings/pages/CommandsPage";
import { RemindersPage } from "./settings/pages/RemindersPage";
import { NilaPage } from "./settings/pages/NilaPage";
import { AppearancePage } from "./settings/pages/AppearancePage";
import { AccessibilityPage } from "./settings/pages/AccessibilityPage";
import { AboutPage } from "./settings/pages/AboutPage";
import type { ReminderInput } from "./settings/ReminderEditor";

const ACCENT_VARS: Record<AppSettings["accent"], [string, string]> = {
  teal: ["#0d9488", "rgba(13,148,136,0.13)"],
  amber: ["#d97706", "rgba(217,119,6,0.13)"],
  rose: ["#e11d48", "rgba(225,29,72,0.12)"],
  indigo: ["#6366f1", "rgba(99,102,241,0.13)"],
};

interface Props {
  settings: AppSettings;
  paused: boolean;
  reminders: Reminder[];
  /** When true the OS draws the titlebar (native decorations); the
   *  custom titlebar hides to avoid a double header. */
  nativeTitlebar?: boolean;
  onSave: (s: AppSettings) => void;
  onPause: (minutes: 30 | 60 | null) => void;
  onResume: () => void;
  onTest: () => void;
  /** Dev-only dock preview. Optional until App wires it; no-op fallback. */
  onPreviewDock?: (kind: "short" | "long" | "queue") => void;
  onClose: () => void;
  onMinimize: () => void;
  /** Page the panel opens on. Defaults to "general". */
  initialPage?: PageId;
  /** Open the reminder editor immediately (tray "New Reminder"). */
  autoNewReminder?: boolean;
  /** Voice-prefilled title for the new-reminder editor. */
  prefillTitle?: string;
  /** First-run flow: the welcome page shows its finish button. */
  setupMode?: boolean;
  /** Called when the user finishes the first-run setup. */
  onSetupComplete?: () => void;
  onDataChanged: () => void;
  onFlash?: (name: ExpressionName) => void;
  onToggleReminder: (id: string, enabled: boolean) => void;
  onDeleteReminder: (id: string) => void;
  onCreateReminder: (input: ReminderInput) => void;
  onUpdateReminder: (id: string, input: ReminderInput) => void;
}

export function SettingsPanel({
  settings,
  paused,
  reminders,
  nativeTitlebar,
  onSave,
  onPause,
  onResume,
  onTest,
  onPreviewDock,
  onClose,
  onMinimize,
  initialPage,
  autoNewReminder,
  prefillTitle,
  setupMode,
  onSetupComplete,
  onDataChanged,
  onFlash,
  onToggleReminder,
  onDeleteReminder,
  onCreateReminder,
  onUpdateReminder,
}: Props) {
  const [page, setPage] = useState<PageId>(initialPage ?? "general");
  /** Bumped to open the reminder editor from the welcome page. */
  const [editorSignal, setEditorSignal] = useState(0);
  const lang: Language = settings.language;
  const t = getStrings(lang);

  const update = (patch: Partial<AppSettings>) =>
    onSave({ ...settings, ...patch });

  /** First-run completion: persist the flag, then hand off to the app. */
  const finishSetup = () => {
    update({ setup_complete: true });
    onSetupComplete?.();
  };

  /** Welcome page "Create your first reminder": jump to Reminders with the
   *  editor already open (setup mode stays on until Continue). */
  const createFirstReminder = () => {
    setPage("reminders");
    setEditorSignal((n) => n + 1);
  };

  // Quiet-hours banner: visible when reminders are currently suppressed.
  const quietUntil = quietHoursActive(settings.quiet_start, settings.quiet_end);

  // Resolved theme for the settings chrome + character preview.
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
  );
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const theme =
    settings.appearance === "system"
      ? systemDark
        ? "dark"
        : "light"
      : settings.appearance;

  // Escape closes the panel, but not while the reminder editor dialog is
  // open — the editor (rendered by the Reminders page) consumes its own
  // Escape key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (document.querySelector(".editor-backdrop")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const [accent, accentSoft] = ACCENT_VARS[settings.accent] ?? ACCENT_VARS.teal;

  return (
    <div
      className="settings"
      data-theme={theme}
      data-motion={settings.animation === "off" ? "off" : "full"}
      style={{ "--st-accent": accent, "--st-accent-soft": accentSoft } as React.CSSProperties}
      role="dialog"
      aria-label={t.window.title}
    >
      <SettingsLayout
        t={t}
        active={page}
        onNavigate={setPage}
        onClose={onClose}
        onMinimize={onMinimize}
        nativeTitlebar={nativeTitlebar}
        setupMode={setupMode}
        onSetupContinue={finishSetup}
      >
        {quietUntil && (
          <div className="quiet-banner" role="status">
            {fill(t.window.quietActive, { time: quietUntil })}
          </div>
        )}
        {page === "welcome" && (
          <WelcomePage
            t={t}
            settings={settings}
            update={update}
            setupMode={setupMode}
            onFinishSetup={finishSetup}
            onCreateFirstReminder={createFirstReminder}
          />
        )}
        {page === "general" && (
          <GeneralPage
            t={t}
            settings={settings}
            update={update}
            paused={paused}
            pausedUntil={settings.paused_until}
            onPause={onPause}
            onResume={onResume}
            onTest={onTest}
            onDataChanged={onDataChanged}
            onFlash={onFlash}
          />
        )}
        {page === "jev" && <JevPage t={t} settings={settings} update={update} />}
        {page === "commands" && <CommandsPage t={t} settings={settings} update={update} />}
        {page === "reminders" && (
          <RemindersPage
            t={t}
            lang={lang}
            reminders={reminders}
            autoNew={autoNewReminder}
            prefillTitle={prefillTitle}
            openEditorSignal={editorSignal}
            onToggle={onToggleReminder}
            onDelete={onDeleteReminder}
            onCreate={onCreateReminder}
            onUpdate={onUpdateReminder}
          />
        )}
        {page === "nila" && (
          <NilaPage
            t={t}
            settings={settings}
            update={update}
            onPreview={onPreviewDock ?? (() => {})}
          />
        )}
        {page === "appearance" && (
          <AppearancePage t={t} settings={settings} update={update} />
        )}
        {page === "accessibility" && (
          <AccessibilityPage t={t} settings={settings} update={update} />
        )}
        {page === "about" && (
          <AboutPage
            t={t}
            settings={settings}
            update={update}
            onOpenWelcome={() => setPage("welcome")}
          />
        )}
      </SettingsLayout>
    </div>
  );
}
