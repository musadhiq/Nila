/**
 * Notifications page — desktop notifications, sound, and how a due
 * reminder presents itself. V1 offers the top-center notification dock
 * or a plain system notification.
 */
import { SettingsRow, SettingsSection, Switch, Select } from "../ui";
import type { PageProps } from "./page";
import type { AppSettings } from "../../../lib/types";

const BEHAVIORS: AppSettings["reminder_behavior"][] = ["dock", "system"];

export function NotificationsPage({ t, settings, update }: PageProps) {
  const n = t.notifications;
  const behaviorMeta: Record<
    AppSettings["reminder_behavior"],
    { title: string; desc: string }
  > = {
    dock: { title: n.behaviorDock, desc: n.behaviorDockDesc },
    system: { title: n.behaviorSystem, desc: n.behaviorSystemDesc },
  };
  return (
    <div className="settings-content-inner">
      <SettingsSection title={n.desktopSection}>
        <SettingsRow
          title={n.desktopTitle}
          description={n.desktopDesc}
          control={
            <Switch
              checked={settings.desktop_notifications}
              onChange={(v) => update({ desktop_notifications: v })}
              label={n.desktopTitle}
            />
          }
        />
        <SettingsRow
          title={n.soundTitle}
          description={n.soundDesc}
          control={
            <Select
              label={n.soundTitle}
              value={settings.sound}
              onChange={(v) =>
                update({ sound: v as AppSettings["sound"] })
              }
              options={[
                { value: "none", label: n.soundNone },
                { value: "soft", label: n.soundSoft },
                { value: "chime", label: n.soundGentle },
              ]}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title={n.behaviorSection}>
        {BEHAVIORS.map((b) => (
          <SettingsRow
            key={b}
            title={behaviorMeta[b].title}
            description={behaviorMeta[b].desc}
            onActivate={() => update({ reminder_behavior: b })}
            control={
              <span role="radio" aria-checked={settings.reminder_behavior === b}>
                <span className="radio-dot" />
              </span>
            }
          />
        ))}
      </SettingsSection>
    </div>
  );
}
