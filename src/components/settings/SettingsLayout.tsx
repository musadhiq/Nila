/**
 * SettingsLayout — the two-column premium settings shell.
 *
 * Left: compact icon+label sidebar. Right: the active page.
 * Includes a slim custom titlebar (the window is frameless) with a drag
 * region, minimize and close.
 */
import type { ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Dict } from "../../lib/i18n";
import { isTauri } from "../../lib/tauri";
import {
  IconAbout,
  IconAccessibility,
  IconAppearance,
  IconCharacter,
  IconClose,
  IconGeneral,
  IconMinus,
  IconReminders,
  IconWelcome,
} from "./icons";
import idleUrl from "../../../character/states/idle.png";

export type PageId =
  | "welcome"
  | "general"
  | "nila"
  | "reminders"
  | "appearance"
  | "accessibility"
  | "about";

const PAGES: { id: PageId; icon: (p: { className?: string }) => ReactNode }[] = [
  { id: "welcome", icon: IconWelcome },
  { id: "general", icon: IconGeneral },
  { id: "nila", icon: IconCharacter },
  { id: "reminders", icon: IconReminders },
  { id: "appearance", icon: IconAppearance },
  { id: "accessibility", icon: IconAccessibility },
  { id: "about", icon: IconAbout },
];

export function SettingsLayout({
  t,
  active,
  onNavigate,
  onClose,
  onMinimize,
  nativeTitlebar,
  setupMode,
  onSetupContinue,
  children,
}: {
  t: Dict;
  active: PageId;
  onNavigate: (p: PageId) => void;
  onClose: () => void;
  onMinimize: () => void;
  /** When true the OS draws the titlebar; hide the custom one. */
  nativeTitlebar?: boolean;
  /** First-run flow: show a slim Continue footer on non-welcome pages. */
  setupMode?: boolean;
  /** Called when the first-run user taps Continue from the footer. */
  onSetupContinue?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="settings">
      <aside className="settings-sidebar" aria-label={t.window.title}>
        <div className="sidebar-brand">
          <img src={idleUrl} alt="" className="sidebar-avatar" draggable={false} />
          <span className="sidebar-brand-text">
            <span className="sidebar-name">Nila</span>
            <span className="sidebar-caption">{t.window.title}</span>
          </span>
        </div>
        <nav className="settings-nav" aria-label={t.window.title}>
          {PAGES.map(({ id, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className="nav-item"
              aria-current={active === id ? "page" : undefined}
              onClick={() => onNavigate(id)}
            >
              <Icon className="nav-icon" />
              <span className="nav-label">{t.nav[id]}</span>
            </button>
          ))}
        </nav>
      </aside>
      <div className="settings-main">
        {!nativeTitlebar && (
          <div
            className="st-titlebar"
            onMouseDown={(e) => {
              // Explicit drag initiation: data-tauri-drag-region is flaky
              // on some Linux/Wayland compositors, so start the native drag
              // ourselves. Presses that begin on a window-control button are
              // left alone so minimize/close clicks keep working.
              if (e.button !== 0 || !isTauri()) return;
              if ((e.target as HTMLElement).closest("button")) return;
              void getCurrentWindow().startDragging().catch(() => {});
            }}
          >
            <span className="st-titlebar-title">{t.page[active].title}</span>
            <span className="st-titlebar-actions">
              <button
                type="button"
                className="st-winbtn"
                onClick={onMinimize}
                aria-label="Minimize"
              >
                <IconMinus />
              </button>
              <button
                type="button"
                className="st-winbtn close"
                onClick={onClose}
                aria-label={t.common.close}
              >
                <IconClose />
              </button>
            </span>
          </div>
        )}
        <main className="settings-content" key={active}>
          <header className="page-header">
            <h1 className="page-title">{t.page[active].title}</h1>
            <p className="page-subtitle">{t.page[active].subtitle}</p>
          </header>
          {children}
        </main>
        {setupMode && active !== "welcome" && (
          <footer className="setup-footer">
            <button
              type="button"
              className="btn primary"
              onClick={() => onSetupContinue?.()}
            >
              {t.welcome.continue}
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}
