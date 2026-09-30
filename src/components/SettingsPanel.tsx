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
import { GeneralPage } from "./settings/pages/GeneralPage";
import { RemindersPage } from "./settings/pages/RemindersPage";
import { CharacterPage } from "./settings/pages/CharacterPage";
import { AppearancePage } from "./settings/pages/AppearancePage";
import { SchedulePage } from "./settings/pages/SchedulePage";
import { NotificationsPage } from "./settings/pages/NotificationsPage";
import { LanguagePage } from "./settings/pages/LanguagePage";
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
  onClose: () => void;
  onMinimize: () => void;
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
  onClose,
  onMinimize,
  onDataChanged,
  onFlash,
  onToggleReminder,
  onDeleteReminder,
  onCreateReminder,
  onUpdateReminder,
}: Props) {
  const [page, setPage] = useState<PageId>("general");
  const lang: Language = settings.language;
  const t = getStrings(lang);

  const update = (patch: Partial<AppSettings>) =>
    onSave({ ...settings, ...patch });

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
      >
        {quietUntil && (
          <div className="quiet-banner" role="status">
            {fill(t.window.quietActive, { time: quietUntil })}
          </div>
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
        {page === "reminders" && (
          <RemindersPage
            t={t}
            lang={lang}
            reminders={reminders}
            onToggle={onToggleReminder}
            onDelete={onDeleteReminder}
            onCreate={onCreateReminder}
            onUpdate={onUpdateReminder}
          />
        )}
        {page === "character" && (
          <CharacterPage
            t={t}
            settings={settings}
            update={update}
            dark={theme === "dark"}
          />
        )}
        {page === "appearance" && (
          <AppearancePage t={t} settings={settings} update={update} />
        )}
        {page === "schedule" && (
          <SchedulePage t={t} settings={settings} update={update} />
        )}
        {page === "notifications" && (
          <NotificationsPage t={t} settings={settings} update={update} />
        )}
        {page === "language" && (
          <LanguagePage t={t} settings={settings} update={update} />
        )}
        {page === "about" && (
          <AboutPage t={t} settings={settings} update={update} />
        )}
      </SettingsLayout>
    </div>
  );
}
