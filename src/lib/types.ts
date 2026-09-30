// Shared frontend types. Mirrors the Rust backend models.

export type ReminderKind = "water" | "food" | "break" | "move" | "sleep" | "custom";

export type Schedule =
  | { type: "once"; at: string }
  | { type: "daily"; time: string }
  | { type: "weekly"; days: number[]; time: string }
  | { type: "interval"; minutes: number };

export interface Reminder {
  id: string;
  title: string;
  message: string;
  kind: ReminderKind;
  schedule: Schedule;
  enabled: boolean;
}

export interface AppSettings {
  quiet_start: string;      // "HH:MM"
  quiet_end: string;        // "HH:MM"
  daily_limit: number;      // default 8
  cooldown_minutes: number; // default 45
  paused_until: string;     // ISO 8601 or ""
  character_size: "small" | "medium" | "large";
  /** How Nila shows up: always on screen, only when a reminder is due, or never. */
  character_visibility: "always" | "reminding" | "hidden";
  animation: "full" | "reduced" | "off";
  appearance: "system" | "light" | "dark";
  sound: "none" | "soft" | "chime";
  start_at_login: boolean;
  /** Settings UI language. "manglish" = Malayalam in Latin script. */
  language: "en" | "manglish";
  /** How a due reminder presents itself. */
  reminder_behavior: "bubble" | "character" | "system";
  /** Also send an OS notification with each reminder (backstop). */
  desktop_notifications: boolean;
  /** Idle animation ambience for the character. */
  idle_behavior: "normal" | "minimal";
  /** Accent color used across the settings UI. */
  accent: "teal" | "amber" | "rose" | "indigo";
}

export const DEFAULT_SETTINGS: AppSettings = {
  quiet_start: "22:00",
  quiet_end: "08:00",
  daily_limit: 8,
  cooldown_minutes: 45,
  paused_until: "",
  character_size: "small",
  character_visibility: "reminding",
  animation: "full",
  appearance: "system",
  sound: "chime",
  start_at_login: true,
  language: "en",
  reminder_behavior: "bubble",
  desktop_notifications: true,
  idle_behavior: "normal",
  accent: "teal",
};

export type NilaEvent =
  | "REMINDER_DUE"
  | "REMINDER_SHOWN"
  | "REMINDER_DISMISSED"
  | "REMINDER_SNOOZED"
  | "REMINDER_COMPLETED"
  | "SETTINGS_CHANGED"
  | "SYSTEM_SLEEP"
  | "SYSTEM_WAKE"
  | "THEME_CHANGED"
  | "CHARACTER_CLICK"
  | "CHARACTER_HOVER"
  | "CHARACTER_STATE_CHANGED";
