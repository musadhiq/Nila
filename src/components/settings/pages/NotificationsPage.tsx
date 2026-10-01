/**
 * Notifications page — sound for the dock. V1 shows reminders only in
 * Nila's top-center notification dock; there is no system-notification
 * mode and no extra OS notification.
 */
import { SettingsRow, SettingsSection, Select } from "../ui";
import type { PageProps } from "./page";
import type { AppSettings } from "../../../lib/types";

export function NotificationsPage({ t, settings, update }: PageProps) {
  const n = t.notifications;
  return (
    <div className="settings-content-inner">
      <SettingsSection title={n.soundSection}>
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
    </div>
  );
}
