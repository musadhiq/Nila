// Reminder + settings helpers. The Rust backend stores schedules as
// JSON strings and settings as string maps; this module converts to and
// from the typed frontend models.

import type { AppSettings, Reminder, ReminderKind, Schedule } from "./types.ts";
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
  const v = JSON.parse(raw) as { type?: string; at?: unknown; time?: unknown; days?: unknown; minutes?: unknown };
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
  if (raw.language === "en" || raw.language === "manglish") {
    s.language = raw.language;
  }
  if (
    raw.reminder_behavior === "bubble" ||
    raw.reminder_behavior === "character" ||
    raw.reminder_behavior === "system"
  ) {
    s.reminder_behavior = raw.reminder_behavior;
  }
  if (raw.desktop_notifications !== undefined) {
    s.desktop_notifications = raw.desktop_notifications === "true";
  }
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
    language: s.language,
    reminder_behavior: s.reminder_behavior,
    desktop_notifications: s.desktop_notifications ? "true" : "false",
    idle_behavior: s.idle_behavior,
    accent: s.accent,
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
          : kind === "move"
            ? { type: "interval", minutes: 120 }
            : kind === "food"
              ? { type: "daily", time: "13:00" }
              : { type: "daily", time: "22:30" },
  }));
