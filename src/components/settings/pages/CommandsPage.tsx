/**
 * Commands page — the full list of voice commands Nila understands,
 * grouped by category. Opened from Settings or by saying "Hi Nila,
 * what can you do?".
 */
import { SettingsSection } from "../ui";
import type { PageProps } from "./page";

export function CommandsPage({ t }: PageProps) {
  const c = t.page.commands;
  const e = c.examples;
  const groups: { title: string; items: string[] }[] = [
    {
      title: c.reminders,
      items: [e.remindMe, e.newReminder, e.showReminders, e.cancelReminder],
    },
    {
      title: c.appsFiles,
      items: [e.openApp, e.closeApp, e.findFile, e.openFolder, e.createFolder],
    },
    {
      title: c.system,
      items: [e.systemInfo, e.battery],
    },
    {
      title: c.chat,
      items: [e.time, e.date, e.help, e.thanks, e.goodbye],
    },
  ];
  return (
    <div className="settings-content-inner">
      {groups.map((g) => (
        <SettingsSection key={g.title} title={g.title}>
          <ul className="commands-list">
            {g.items.map((item) => (
              <li key={item} className="commands-item">
                <span className="commands-quote">“</span>
                <span>{item}</span>
                <span className="commands-quote">”</span>
              </li>
            ))}
          </ul>
        </SettingsSection>
      ))}
    </div>
  );
}
