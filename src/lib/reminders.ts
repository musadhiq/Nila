// Reminder + settings helpers. The Rust backend stores schedules as
// JSON strings and settings as string maps; this module converts to and
// from the typed frontend models.

import type {
  AppSettings,
  EntranceBehavior,
  ExitBehavior,
  IdlePresence,
  MonitorMode,
  PositionPreset,
  Reminder,
  ReminderKind,
  SavedPresencePos,
  Schedule,
  SystemMetric,
} from "./types.ts";
import { POSITION_PRESETS } from "./types.ts";
import { BUILT_IN_MESSAGES, BUILT_IN_TITLES } from "./strings.ts";
import { DEFAULT_SETTINGS } from "./types.ts";

/** Raw reminder shape as returned by the Rust backend over IPC. */
export interface ReminderDto {
  id: string;
  title: string;
  message: string;
  kind: string;
  schedule: string; // JSON
  enabled: boolean;
}

export function parseSchedule(raw: string): Schedule {
  const v = JSON.parse(raw) as { type?: string; at?: unknown; time?: unknown; days?: unknown; minutes?: unknown; metric?: unknown };
  switch (v.type) {
    case "once":
      return { type: "once", at: String(v.at ?? "") };
    case "daily":
      return { type: "daily", time: String(v.time ?? "09:00") };
    case "weekly":
      return {
        type: "weekly",
        days: Array.isArray(v.days) ? v.days.map((d) => Number(d)).filter((d) => d >= 0 && d <= 6) : [],
        time: String(v.time ?? "09:00"),
      };
    case "interval":
      return { type: "interval", minutes: Math.max(1, Number(v.minutes ?? 60) || 60) };
    case "system": {
      const metric = String(v.metric ?? "battery_low");
      const known: SystemMetric[] = ["battery_low", "cpu_high", "memory_high", "disk_low"];
      return { type: "system", metric: (known as string[]).includes(metric) ? (metric as SystemMetric) : "battery_low" };
    }
    default:
      throw new Error(`unknown schedule type: ${String(v.type)}`);
  }
}

export function toReminder(dto: ReminderDto): Reminder {
  return {
    id: dto.id,
    title: dto.title,
    message: dto.message,
    kind: dto.kind as ReminderKind,
    schedule: parseSchedule(dto.schedule),
    enabled: dto.enabled,
  };
}

export function scheduleToJson(s: Schedule): string {
  return JSON.stringify(s);
}

/**
 * Combine a local calendar date ("YYYY-MM-DD") and time ("HH:MM") from the
 * editor into a UTC ISO instant for storage. Returns null when either part
 * is missing or the combination isn't a valid date-time.
 */
export function onceToIso(date: string, time: string): string | null {
  if (!date || !time) return null;
  const d = new Date(`${date}T${time}`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** True when the ISO instant is at or before now (a once-reminder that could never fire). */
export function isPastIso(iso: string, nowMs: number = Date.now()): boolean {
  const at = Date.parse(iso);
  return Number.isNaN(at) || at <= nowMs;
}

/** Short Malayalam description of a schedule, for list rows. */
export function describeSchedule(s: Schedule): string {
  switch (s.type) {
    case "once":
      return `Once · ${s.at}`;
    case "daily":
      return `Daily · ${s.time}`;
    case "weekly": {
      const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const days = s.days.map((d) => names[d] ?? "").filter(Boolean).join(", ");
      return `Weekly · ${days || "—"} · ${s.time}`;
    }
    case "interval":
      return `Every ${s.minutes} min`;
    case "system":
      return `System · ${s.metric}`;
  }
}

export function mergeSettings(raw: Record<string, string>): AppSettings {
  const s: AppSettings = { ...DEFAULT_SETTINGS };
  if (raw.quiet_start) s.quiet_start = raw.quiet_start;
  if (raw.quiet_end) s.quiet_end = raw.quiet_end;
  if (raw.paused_until !== undefined) s.paused_until = raw.paused_until;
  const num = (v: string | undefined): number | undefined => {
    if (v === undefined || v === "") return undefined;
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? undefined : n;
  };
  const dl = num(raw.daily_limit);
  if (dl !== undefined) s.daily_limit = dl;
  const cd = num(raw.cooldown_minutes);
  if (cd !== undefined) s.cooldown_minutes = cd;
  if (raw.character_size === "small" || raw.character_size === "medium" || raw.character_size === "large") {
    s.character_size = raw.character_size;
  }
  if (
    raw.character_visibility === "always" ||
    raw.character_visibility === "reminding" ||
    raw.character_visibility === "hidden"
  ) {
    s.character_visibility = raw.character_visibility;
  }
  if (raw.animation === "full" || raw.animation === "reduced" || raw.animation === "off") {
    s.animation = raw.animation;
  }
  if (raw.appearance === "system" || raw.appearance === "light" || raw.appearance === "dark") {
    s.appearance = raw.appearance;
  }
  if (raw.sound === "none" || raw.sound === "soft" || raw.sound === "chime") {
    s.sound = raw.sound;
  }
  if (raw.start_at_login !== undefined) s.start_at_login = raw.start_at_login === "true";
  if (raw.wake_word_enabled !== undefined) s.wake_word_enabled = raw.wake_word_enabled === "true";
  if (raw.setup_complete !== undefined) s.setup_complete = raw.setup_complete === "true";
  if (raw.language === "en" || raw.language === "manglish") {
    s.language = raw.language;
  }
  // V1: the top-center notification dock is the only reminder surface.
  // Legacy values ("bubble", "character", "system") all migrate to it,
  // and the extra OS notification is forced off.
  s.reminder_behavior = "dock";
  s.desktop_notifications = false;
  if (raw.idle_behavior === "normal" || raw.idle_behavior === "minimal") {
    s.idle_behavior = raw.idle_behavior;
  }
  if (
    raw.accent === "teal" ||
    raw.accent === "amber" ||
    raw.accent === "rose" ||
    raw.accent === "indigo"
  ) {
    s.accent = raw.accent;
  }
  // --- Character presence & positioning ---
  const isPreset = (v: string | undefined): v is PositionPreset =>
    v !== undefined && (POSITION_PRESETS as string[]).includes(v);
  if (isPreset(raw.position_preset)) s.position_preset = raw.position_preset;
  const entrances: EntranceBehavior[] = ["fade", "slide", "pop", "peek", "bounce", "gentle"];
  if (raw.entrance && (entrances as string[]).includes(raw.entrance)) {
    s.entrance = raw.entrance as EntranceBehavior;
  }
  const exits: ExitBehavior[] = ["fade", "slide", "retreat", "peek-out"];
  if (raw.exit_behavior && (exits as string[]).includes(raw.exit_behavior)) {
    s.exit_behavior = raw.exit_behavior as ExitBehavior;
  }
  const idles: IdlePresence[] = [
    "visible",
    "mostly-visible",
    "partially-hidden",
    "peek-from-edge",
    "hidden",
    "gentle-idle",
  ];
  if (raw.idle_presence && (idles as string[]).includes(raw.idle_presence)) {
    s.idle_presence = raw.idle_presence as IdlePresence;
  }
  const frac = (v: string | undefined): number | undefined => {
    if (v === undefined || v === "") return undefined;
    const n = parseFloat(v);
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : undefined;
  };
  const pk = frac(raw.peek_amount);
  if (pk !== undefined) s.peek_amount = pk;
  const eo = num(raw.edge_offset);
  if (eo !== undefined) s.edge_offset = Math.min(200, Math.max(0, eo));
  const tl = raw.tilt !== undefined && raw.tilt !== "" ? parseFloat(raw.tilt) : undefined;
  if (tl !== undefined && Number.isFinite(tl)) s.tilt = Math.min(8, Math.max(-8, tl));
  if (raw.top_hang !== undefined) s.top_hang = raw.top_hang === "true";
  const ems = num(raw.entrance_ms);
  if (ems !== undefined) s.entrance_ms = Math.min(900, Math.max(0, ems));
  const xms = num(raw.exit_ms);
  if (xms !== undefined) s.exit_ms = Math.min(900, Math.max(0, xms));
  if (raw.draggable !== undefined) s.draggable = raw.draggable === "true";
  if (raw.snap_enabled !== undefined) s.snap_enabled = raw.snap_enabled === "true";
  const st = num(raw.snap_threshold);
  if (st !== undefined) s.snap_threshold = Math.min(120, Math.max(0, st));
  if (raw.natural_appearances !== undefined) {
    s.natural_appearances = raw.natural_appearances === "true";
  }
  if (raw.enabled_positions) {
    try {
      const arr = JSON.parse(raw.enabled_positions) as unknown;
      if (Array.isArray(arr)) {
        const clean = arr.filter((p): p is PositionPreset => isPreset(String(p)));
        if (clean.length > 0) s.enabled_positions = clean;
      }
    } catch {
      /* keep default */
    }
  }
  const mmodes: MonitorMode[] = ["main", "current", "remember", "specific"];
  if (raw.monitor_mode && (mmodes as string[]).includes(raw.monitor_mode)) {
    s.monitor_mode = raw.monitor_mode as MonitorMode;
  }
  const mi = num(raw.monitor_index);
  if (mi !== undefined) s.monitor_index = Math.max(0, mi);
  if (raw.presence_pos) {
    try {
      const p = JSON.parse(raw.presence_pos) as Partial<SavedPresencePos>;
      if (
        typeof p.x === "number" &&
        typeof p.y === "number" &&
        typeof p.monitor === "number" &&
        isPreset(p.preset)
      ) {
        s.presence_pos = { x: p.x, y: p.y, monitor: p.monitor, preset: p.preset };
      }
    } catch {
      /* keep null */
    }
  }
  return s;
}

export function settingsToRecord(s: AppSettings): Record<string, string> {
  return {
    quiet_start: s.quiet_start,
    quiet_end: s.quiet_end,
    daily_limit: String(s.daily_limit),
    cooldown_minutes: String(s.cooldown_minutes),
    paused_until: s.paused_until,
    character_size: s.character_size,
    character_visibility: s.character_visibility,
    animation: s.animation,
    appearance: s.appearance,
    sound: s.sound,
    start_at_login: s.start_at_login ? "true" : "false",
    wake_word_enabled: s.wake_word_enabled ? "true" : "false",
    setup_complete: s.setup_complete ? "true" : "false",
    language: s.language,
    reminder_behavior: s.reminder_behavior,
    desktop_notifications: s.desktop_notifications ? "true" : "false",
    idle_behavior: s.idle_behavior,
    accent: s.accent,
    position_preset: s.position_preset,
    entrance: s.entrance,
    exit_behavior: s.exit_behavior,
    idle_presence: s.idle_presence,
    peek_amount: String(s.peek_amount),
    edge_offset: String(s.edge_offset),
    tilt: String(s.tilt),
    top_hang: s.top_hang ? "true" : "false",
    entrance_ms: String(s.entrance_ms),
    exit_ms: String(s.exit_ms),
    draggable: s.draggable ? "true" : "false",
    snap_enabled: s.snap_enabled ? "true" : "false",
    snap_threshold: String(s.snap_threshold),
    natural_appearances: s.natural_appearances ? "true" : "false",
    enabled_positions: JSON.stringify(s.enabled_positions),
    monitor_mode: s.monitor_mode,
    monitor_index: String(s.monitor_index),
    presence_pos: s.presence_pos ? JSON.stringify(s.presence_pos) : "",
  };
}

/** Built-in reminders seeded on first launch. */
export interface BuiltInTemplate {
  kind: ReminderKind;
  title: string;
  message: string;
  schedule: Schedule;
}

export const BUILT_IN_TEMPLATES: BuiltInTemplate[] = (Object.keys(BUILT_IN_TITLES) as ReminderKind[])
  .filter((kind) => kind !== "custom")
  .map((kind) => ({
    kind,
    title: BUILT_IN_TITLES[kind],
    message: BUILT_IN_MESSAGES[kind]?.[0] ?? "",
    schedule:
      kind === "water"
        ? { type: "interval", minutes: 60 }
        : kind === "break"
          ? { type: "interval", minutes: 90 }
          : kind === "move" || kind === "stretch"
            ? { type: "interval", minutes: 120 }
            : kind === "food"
              ? { type: "daily", time: "13:00" }
              : kind === "exercise"
                ? { type: "daily", time: "07:00" }
                : kind === "work"
                  ? { type: "daily", time: "09:00" }
                  : { type: "daily", time: "22:30" },
  }));

/**
 * Check if the current local time falls within quiet hours.
 * Returns the quiet-end time (HH:MM) if active, null otherwise.
 */
export function quietHoursActive(
  quietStart: string,
  quietEnd: string,
  now: Date = new Date(),
): string | null {
  const parse = (s: string): [number, number] | null => {
    const [h, m] = s.split(":").map(Number);
    if (Number.isNaN(h) || Number.isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
    return [h, m];
  };
  const start = parse(quietStart);
  const end = parse(quietEnd);
  if (!start || !end) return null;

  const mins = now.getHours() * 60 + now.getMinutes();
  const s = start[0] * 60 + start[1];
  const e = end[0] * 60 + end[1];

  const inQuiet = s <= e ? mins >= s && mins < e : mins >= s || mins < e;
  return inQuiet ? quietEnd : null;
}
