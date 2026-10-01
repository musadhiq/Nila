/**
 * Accessibility page — motion and sound, tuned to the user's comfort.
 *
 * Motion: how much Nila moves (full / reduced / off). Sound: the gentle
 * tone that accompanies a dock reminder, or silence.
 */
import { SettingsRow, SettingsSection, Segmented, Select } from "../ui";
import type { PageProps } from "./page";
import type { AppSettings } from "../../../lib/types";

export function AccessibilityPage({ t, settings, update }: PageProps) {
  const a = t.accessibility;
  const n = t.notifications;
  return (
    <div className="settings-content-inner">
      <SettingsSection title={a.motionSection}>
        <SettingsRow
          title={a.motionSection}
          description={a.motionDesc}
          control={
            <Segmented
              label={a.motionSection}
              value={settings.animation}
              onChange={(v) => update({ animation: v })}
              options={[
                { value: "full", label: a.motionFull },
                { value: "reduced", label: a.motionReduced },
                { value: "off", label: a.motionOff },
              ]}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title={n.soundSection}>
        <SettingsRow
          title={n.soundTitle}
          description={n.soundDesc}
          control={
            <Select
              label={n.soundTitle}
              value={settings.sound}
              onChange={(v) => update({ sound: v as AppSettings["sound"] })}
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
