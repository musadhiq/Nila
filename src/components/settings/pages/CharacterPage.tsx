/**
 * Character page — presence & positioning (spec 33-57).
 *
 * A live preview stage, a visual 3x3 position selector, appearance and
 * behavior controls, and a collapsed "advanced" section. Every control
 * applies immediately, including to the live Nila window when visible.
 */
import { useEffect, useRef, useState } from "react";
import { availableMonitors } from "@tauri-apps/api/window";
import { NilaCharacter } from "../../../character/NilaCharacter";
import {
  characterTransformCSS,
  presetEdges,
  stagePositionFor,
} from "../../../character/presence";
import type { Dict } from "../../../lib/i18n";
import { fill } from "../../../lib/i18n";
import { isTauri } from "../../../lib/tauri";
import type {
  AppSettings,
  EntranceBehavior,
  ExitBehavior,
  IdlePresence,
  MonitorMode,
  PositionPreset,
} from "../../../lib/types";
import { POSITION_PRESETS } from "../../../lib/types";
import { SettingsRow, SettingsSection, Segmented, Select, Slider, Switch } from "../ui";
import type { PageProps } from "./page";

/* ------------------------------------------------------------------ */
/* Live preview stage                                                  */
/* ------------------------------------------------------------------ */

type PreviewPhase = "idle" | "entering" | "visible" | "exiting";

function PresencePreview({
  t,
  settings,
  dark,
}: {
  t: Dict;
  settings: AppSettings;
  dark: boolean;
}) {
  const c = t.character;
  const [phase, setPhase] = useState<PreviewPhase>("idle");
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((id) => window.clearTimeout(id)), []);

  const reduced = settings.animation !== "full";
  const entrance: EntranceBehavior | "fade" = reduced ? "fade" : settings.entrance;
  const exit: ExitBehavior | "fade" = reduced ? "fade" : settings.exit_behavior;

  const play = () => {
    timers.current.forEach((id) => window.clearTimeout(id));
    timers.current = [];
    setPhase("entering");
    timers.current.push(
      window.setTimeout(() => {
        setPhase("visible");
        timers.current.push(
          window.setTimeout(() => {
            setPhase("exiting");
            timers.current.push(
              window.setTimeout(() => setPhase("idle"), settings.exit_ms + 80),
            );
          }, 1100),
        );
      }, settings.entrance_ms + 80),
    );
  };

  const pos = stagePositionFor(settings.position_preset);
  const edges = presetEdges(settings.position_preset);
  // Entrance travel direction for slide/peek/bounce (percent of dot size).
  const dx = edges.includes("right") ? "160%" : edges.includes("left") ? "-160%" : "0%";
  const dy = edges.includes("top") ? "-160%" : "160%";

  const animClass =
    phase === "entering"
      ? `pv-enter-${entrance}`
      : phase === "exiting"
        ? `pv-exit-${exit === "peek-out" ? "peek" : exit}`
        : "";
  const hidden = phase === "idle" && settings.idle_presence === "hidden";
  // Peek-style idle modes rest partly outside the mini desktop, like the
  // real window hanging off the screen edge (spec 35/40).
  const peekIdle =
    (settings.idle_presence === "peek-from-edge" ||
      settings.idle_presence === "partially-hidden") &&
    phase !== "entering" &&
    phase !== "exiting";
  const peekX = edges.includes("right") ? "42%" : edges.includes("left") ? "-42%" : "0%";
  const peekY = edges.includes("bottom") ? "42%" : edges.includes("top") ? "-42%" : "0%";

  return (
    <div className="presence-preview">
      <div
        className="pv-stage"
        role="img"
        aria-label={c.positionSection}
        style={{ "--pvx": dx, "--pvy": dy } as React.CSSProperties}
      >
        <span className="pv-stage-label">{c.previewLabel}</span>
        {!hidden && (
          <span
            className={`pv-dot ${animClass}${peekIdle ? " pv-peek" : ""}`}
            style={{
              left: pos.left,
              top: pos.top,
              "--pvpx": peekX,
              "--pvpy": peekY,
            } as React.CSSProperties}
          >
            <span
              className="pv-char"
              style={{ transform: characterTransformCSS(settings.position_preset, settings.top_hang, settings.tilt) }}
            >
              <NilaCharacter
                state="idle"
                animation={null}
                size="small"
                dark={dark}
                expression={null}
                groundShadow={edges.includes("bottom")}
              />
            </span>
          </span>
        )}
      </div>
      <button type="button" className="btn pv-play" onClick={play} disabled={phase !== "idle"}>
        {c.previewButton}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Visual 3x3 position selector (spec 34)                              */
/* ------------------------------------------------------------------ */

function PositionGrid({
  t,
  settings,
  update,
}: {
  t: Dict;
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
}) {
  const c = t.character;
  const multi = settings.natural_appearances;
  const names: Record<PositionPreset, string> = {
    "top-left": c.posTopLeft,
    top: c.posTop,
    "top-right": c.posTopRight,
    left: c.posLeft,
    center: c.posCenter,
    right: c.posRight,
    "bottom-left": c.posBottomLeft,
    bottom: c.posBottom,
    "bottom-right": c.posBottomRight,
  };
  const toggle = (p: PositionPreset) => {
    if (!multi) {
      update({ position_preset: p });
      return;
    }
    const cur = settings.enabled_positions;
    if (cur.includes(p)) {
      if (cur.length <= 1) return; // keep at least one enabled
      update({ enabled_positions: cur.filter((x) => x !== p) });
    } else {
      update({ enabled_positions: [...cur, p] });
    }
  };
  const isActive = (p: PositionPreset) =>
    multi ? settings.enabled_positions.includes(p) : settings.position_preset === p;
  return (
    <div className="pos-grid" role="group" aria-label={c.positionSection}>
      {POSITION_PRESETS.map((p) => (
        <button
          key={p}
          type="button"
          className={`pos-cell${isActive(p) ? " active" : ""}`}
          aria-pressed={isActive(p)}
          aria-label={names[p]}
          title={names[p]}
          onClick={() => toggle(p)}
        >
          <span className="pos-dot" aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

const ENTRANCES: EntranceBehavior[] = ["fade", "slide", "pop", "peek", "bounce", "gentle"];
const EXITS: ExitBehavior[] = ["fade", "slide", "retreat", "peek-out"];
const IDLES: IdlePresence[] = [
  "visible",
  "mostly-visible",
  "partially-hidden",
  "peek-from-edge",
  "hidden",
  "gentle-idle",
];

export function CharacterPage({ t, settings, update, dark }: PageProps & { dark: boolean }) {
  const c = t.character;
  const [advOpen, setAdvOpen] = useState(false);
  const [monitorNames, setMonitorNames] = useState<string[]>([]);

  useEffect(() => {
    if (!isTauri()) return;
    availableMonitors()
      .then((ms) => setMonitorNames(ms.map((m, i) => m.name ?? `Monitor ${i + 1}`)))
      .catch(() => {});
  }, []);

  const entranceDescs: Record<EntranceBehavior, string> = {
    fade: c.entranceFadeDesc,
    slide: c.entranceSlideDesc,
    pop: c.entrancePopDesc,
    peek: c.entrancePeekDesc,
    bounce: c.entranceBounceDesc,
    gentle: c.entranceGentleDesc,
  };
  const entranceLabels: Record<EntranceBehavior, string> = {
    fade: c.entranceFade,
    slide: c.entranceSlide,
    pop: c.entrancePop,
    peek: c.entrancePeek,
    bounce: c.entranceBounce,
    gentle: c.entranceGentle,
  };
  const exitLabels: Record<ExitBehavior, string> = {
    fade: c.exitFade,
    slide: c.exitSlide,
    retreat: c.exitRetreat,
    "peek-out": c.exitPeekOut,
  };
  const idleLabels: Record<IdlePresence, string> = {
    visible: c.idleVisible,
    "mostly-visible": c.idleMostlyVisible,
    "partially-hidden": c.idlePartiallyHidden,
    "peek-from-edge": c.idlePeekFromEdge,
    hidden: c.idleHidden,
    "gentle-idle": c.idleGentleIdle,
  };
  const monitorModes: MonitorMode[] = ["main", "current", "remember", "specific"];
  // Top hanging only makes sense at the top of the screen.
  const canHang = settings.natural_appearances
    ? settings.enabled_positions.some((p) => presetEdges(p).includes("top"))
    : presetEdges(settings.position_preset).includes("top");
  const monitorLabels: Record<MonitorMode, string> = {
    main: c.monitorMain,
    current: c.monitorCurrent,
    remember: c.monitorRemember,
    specific: monitorNames[settings.monitor_index] ?? fill(c.monitorSpecific, { n: String(settings.monitor_index + 1) }),
  };

  return (
    <div className="settings-content-inner">
      <h3 className="presence-heading">{c.presenceTitle}</h3>
      <p className="presence-sub">{c.presenceSubtitle}</p>

      <PresencePreview t={t} settings={settings} dark={dark} />

      <SettingsSection title={c.positionSection}>
        <p className="section-desc">
          {settings.natural_appearances ? c.positionNaturalHint : c.positionDesc}
        </p>
        <PositionGrid t={t} settings={settings} update={update} />
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
        <SettingsRow
          title={c.peekAmount}
          description={c.peekAmountDesc}
          control={
            <Slider
              label={c.peekAmount}
              value={settings.peek_amount}
              min={0.05}
              max={1}
              step={0.05}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(v) => update({ peek_amount: v })}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title={c.behaviorSection}>
        <SettingsRow
          title={c.entranceLabel}
          description={entranceDescs[settings.entrance]}
          control={
            <Select
              label={c.entranceLabel}
              value={settings.entrance}
              onChange={(v) => update({ entrance: v as EntranceBehavior })}
              options={ENTRANCES.map((v) => ({ value: v, label: entranceLabels[v] }))}
            />
          }
        />
        <SettingsRow
          title={c.exitLabel}
          description={c.exitDesc}
          control={
            <Select
              label={c.exitLabel}
              value={settings.exit_behavior}
              onChange={(v) => update({ exit_behavior: v as ExitBehavior })}
              options={EXITS.map((v) => ({ value: v, label: exitLabels[v] }))}
            />
          }
        />
        <SettingsRow
          title={c.idlePresenceLabel}
          description={c.idlePresenceDesc}
          control={
            <Select
              label={c.idlePresenceLabel}
              value={settings.idle_presence}
              onChange={(v) => update({ idle_presence: v as IdlePresence })}
              options={IDLES.map((v) => ({ value: v, label: idleLabels[v] }))}
            />
          }
        />
        {canHang && (
          <SettingsRow
            title={c.topHang}
            description={c.topHangDesc}
            control={
              <Switch
                label={c.topHang}
                checked={settings.top_hang}
                onChange={(v) => update({ top_hang: v })}
              />
            }
          />
        )}
        <SettingsRow
          title={c.tiltLabel}
          description={c.tiltDesc}
          control={
            <Slider
              label={c.tiltLabel}
              value={settings.tilt}
              min={-8}
              max={8}
              step={1}
              format={(v) => fill(c.tiltValue, { deg: String(v) })}
              onChange={(v) => update({ tilt: v })}
            />
          }
        />
      </SettingsSection>

      <div className="advanced">
        <button
          type="button"
          className="advanced-toggle"
          aria-expanded={advOpen}
          onClick={() => setAdvOpen((v) => !v)}
        >
          <span className={`advanced-caret${advOpen ? " open" : ""}`} aria-hidden="true">
            ▸
          </span>
          {c.advancedBehavior}
        </button>
        {advOpen && (
          <div className="advanced-body">
            <SettingsRow
              title={c.edgeOffset}
              description={c.edgeOffsetDesc}
              control={
                <Slider
                  label={c.edgeOffset}
                  value={settings.edge_offset}
                  min={0}
                  max={96}
                  step={2}
                  format={(v) => fill(c.edgeOffsetValue, { n: String(v) })}
                  onChange={(v) => update({ edge_offset: v })}
                />
              }
            />
            <SettingsRow
              title={c.entranceDuration}
              control={
                <Slider
                  label={c.entranceDuration}
                  value={settings.entrance_ms}
                  min={150}
                  max={450}
                  step={25}
                  format={(v) => fill(c.durationValue, { ms: String(v) })}
                  onChange={(v) => update({ entrance_ms: v })}
                />
              }
            />
            <SettingsRow
              title={c.exitDuration}
              control={
                <Slider
                  label={c.exitDuration}
                  value={settings.exit_ms}
                  min={150}
                  max={450}
                  step={25}
                  format={(v) => fill(c.durationValue, { ms: String(v) })}
                  onChange={(v) => update({ exit_ms: v })}
                />
              }
            />
            <SettingsRow
              title={c.draggable}
              description={c.draggableDesc}
              control={
                <Switch
                  label={c.draggable}
                  checked={settings.draggable}
                  onChange={(v) => update({ draggable: v })}
                />
              }
            />
            <SettingsRow
              title={c.snapEnabled}
              description={c.snapEnabledDesc}
              control={
                <Switch
                  label={c.snapEnabled}
                  checked={settings.snap_enabled}
                  onChange={(v) => update({ snap_enabled: v })}
                />
              }
            />
            {settings.snap_enabled && (
              <SettingsRow
                title={c.snapThreshold}
                control={
                  <Slider
                    label={c.snapThreshold}
                    value={settings.snap_threshold}
                    min={0}
                    max={64}
                    step={2}
                    format={(v) => fill(c.snapThresholdValue, { n: String(v) })}
                    onChange={(v) => update({ snap_threshold: v })}
                  />
                }
              />
            )}
            <SettingsRow
              title={c.natural}
              description={c.naturalDesc}
              control={
                <Switch
                  label={c.natural}
                  checked={settings.natural_appearances}
                  onChange={(v) => update({ natural_appearances: v })}
                />
              }
            />
            <SettingsRow
              title={c.monitorSection}
              description={c.monitorDesc}
              control={
                <Select
                  label={c.monitorSection}
                  value={settings.monitor_mode}
                  onChange={(v) => update({ monitor_mode: v as MonitorMode })}
                  options={monitorModes.map((v) => ({ value: v, label: monitorLabels[v] }))}
                />
              }
            />
            {settings.monitor_mode === "specific" && monitorNames.length > 0 && (
              <SettingsRow
                title={monitorNames[settings.monitor_index] ?? c.monitorSection}
                control={
                  <Select
                    label={c.monitorSection}
                    value={String(settings.monitor_index)}
                    onChange={(v) => update({ monitor_index: Number(v) })}
                    options={monitorNames.map((n, i) => ({ value: String(i), label: n }))}
                  />
                }
              />
            )}
          </div>
        )}
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
