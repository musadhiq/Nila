/**
 * Character page — a large live preview plus size, animation and idle
 * behavior. The preview reacts immediately because every control applies
 * instantly.
 */
import { NilaCharacter } from "../../../character/NilaCharacter";
import { SettingsRow, SettingsSection, Segmented } from "../ui";
import type { PageProps } from "./page";

export function CharacterPage({ t, settings, update, dark }: PageProps & { dark: boolean }) {
  const c = t.character;
  return (
    <div className="settings-content-inner">
      <div className="char-preview" aria-label={c.previewLabel}>
        <span className="char-preview-caption">{c.previewLabel}</span>
        <NilaCharacter
          state="idle"
          animation={settings.animation === "off" ? null : "idle-breathe"}
          size={settings.character_size}
          dark={dark}
          expression={null}
        />
      </div>

      <SettingsSection title={c.visibilitySection}>
        <SettingsRow
          title={c.visibilityAlways}
          description={c.visibilityAlwaysDesc}
          onActivate={() => update({ character_visibility: "always" })}
          control={<RadioDot checked={settings.character_visibility === "always"} />}
        />
        <SettingsRow
          title={c.visibilityReminding}
          description={c.visibilityRemindingDesc}
          onActivate={() => update({ character_visibility: "reminding" })}
          control={<RadioDot checked={settings.character_visibility === "reminding"} />}
        />
        <SettingsRow
          title={c.visibilityHidden}
          description={c.visibilityHiddenDesc}
          onActivate={() => update({ character_visibility: "hidden" })}
          control={<RadioDot checked={settings.character_visibility === "hidden"} />}
        />
      </SettingsSection>

      <SettingsSection title={c.sizeSection}>
        <SettingsRow
          title={c.sizeSection}
          description={c.sizeDesc}
          control={
            <Segmented
              label={c.sizeSection}
              value={settings.character_size}
              onChange={(v) => update({ character_size: v })}
              options={[
                { value: "small", label: c.sizeSmall },
                { value: "medium", label: c.sizeMedium },
                { value: "large", label: c.sizeLarge },
              ]}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title={c.animationSection}>
        <SettingsRow
          title={c.animationSection}
          description={c.animationDesc}
          control={
            <Segmented
              label={c.animationSection}
              value={settings.animation}
              onChange={(v) => update({ animation: v })}
              options={[
                { value: "full", label: c.animationFull },
                { value: "reduced", label: c.animationReduced },
                { value: "off", label: c.animationOff },
              ]}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title={c.idleSection}>
        <SettingsRow
          title={c.idleNormal}
          description={c.idleNormalDesc}
          onActivate={() => update({ idle_behavior: "normal" })}
          control={<RadioDot checked={settings.idle_behavior === "normal"} />}
        />
        <SettingsRow
          title={c.idleMinimal}
          description={c.idleMinimalDesc}
          onActivate={() => update({ idle_behavior: "minimal" })}
          control={<RadioDot checked={settings.idle_behavior === "minimal"} />}
        />
      </SettingsSection>
    </div>
  );
}

function RadioDot({ checked }: { checked: boolean }) {
  return (
    <span role="radio" aria-checked={checked} className="radio-wrap">
      <span className="radio-dot" />
    </span>
  );
}
