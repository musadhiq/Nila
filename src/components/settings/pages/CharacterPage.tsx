/**
 * Character page — V1: the Top Center Dock.
 *
 * Nila appears in a small notification dock at the top center of the
 * screen when a reminder is due; she lives in the tray otherwise. This
 * page keeps only the controls that matter for the dock: her size,
 * visibility, animation, and idle behavior. Positioning controls are
 * intentionally absent in V1 — the dock is always top-center.
 *
 * A development-only preview section exercises the real dock with
 * short, long, and queued notifications.
 */
import { NilaCharacter } from "../../../character/NilaCharacter";
import type { Dict } from "../../../lib/i18n";
import { SettingsRow, SettingsSection, Segmented } from "../ui";
import type { PageProps } from "./page";

export type DockPreviewKind = "short" | "long" | "queue";

function DockDiagram({ t }: { t: Dict }) {
  const c = t.character;
  return (
    <div className="dock-diagram" role="img" aria-label={c.dockSection}>
      <div className="dock-diagram-screen">
        <div className="dock-diagram-notch" />
        <div className="dock-diagram-card">
          <span className="dock-diagram-eyebrow">Nila</span>
          <span className="dock-diagram-title">Vellam</span>
          <span className="dock-diagram-msg">Vellam kudicho?</span>
          <span className="dock-diagram-nila">
            <NilaCharacter state="idle" animation="idle-breathe" size="small" />
          </span>
        </div>
      </div>
    </div>
  );
}

export function CharacterPage({
  t,
  settings,
  update,
  onPreview,
}: PageProps & { onPreview: (kind: DockPreviewKind) => void }) {
  const c = t.character;

  return (
    <div className="settings-content-inner">
      <h3 className="presence-heading">{c.presenceTitle}</h3>
      <p className="presence-sub">{c.presenceSubtitle}</p>

      <SettingsSection title={c.dockSection}>
        <p className="section-desc">{c.dockDesc}</p>
        <DockDiagram t={t} />
      </SettingsSection>

      <SettingsSection title={c.appearanceSection}>
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

      <SettingsSection title={c.visibilitySection}>
        <p className="section-desc">{c.visibilityDesc}</p>
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
        <p className="section-desc">{c.idleDesc}</p>
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

      {import.meta.env.DEV && (
        <SettingsSection title={c.previewSection}>
          <p className="section-desc">{c.previewDesc}</p>
          <div className="preview-btn-row">
            <button type="button" className="btn" onClick={() => onPreview("short")}>
              {c.previewShort}
            </button>
            <button type="button" className="btn" onClick={() => onPreview("long")}>
              {c.previewLong}
            </button>
            <button type="button" className="btn" onClick={() => onPreview("queue")}>
              {c.previewQueue}
            </button>
          </div>
        </SettingsSection>
      )}
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
