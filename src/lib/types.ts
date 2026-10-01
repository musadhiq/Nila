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
  reminder_behavior: "bubble" | "character" | "system" | "dock";
  /** Also send an OS notification with each reminder (backstop). */
  desktop_notifications: boolean;
  /** Idle animation ambience for the character. */
  idle_behavior: "normal" | "minimal";
  /** Accent color used across the settings UI. */
  accent: "teal" | "amber" | "rose" | "indigo";
  // --- Character presence & positioning (spec 33-57) ---
  /** Where Nila appears on the desktop. */
  position_preset: PositionPreset;
  /** How Nila enters the screen. */
  entrance: EntranceBehavior;
  /** How Nila leaves the screen. */
  exit_behavior: ExitBehavior;
  /** What Nila does when nothing is happening. */
  idle_presence: IdlePresence;
  /** Fraction of Nila visible when peeking from an edge (0..1). */
  peek_amount: number;
  /** Pixel inset from the chosen edge. */
  edge_offset: number;
  /** Subtle lean when peeking from a side, degrees (-8..8). */
  tilt: number;
  /** Hang upside-down from the top edge (explicit opt-in). */
  top_hang: boolean;
  /** Entrance animation length, ms (150..450). */
  entrance_ms: number;
  /** Exit animation length, ms (150..450). */
  exit_ms: number;
  /** Let Nila be dragged around the desktop. */
  draggable: boolean;
  /** Gently stick to nearby edges while dragging. */
  snap_enabled: boolean;
  /** Snap activation distance, px. */
  snap_threshold: number;
  /** Occasionally appear at a different enabled position. */
  natural_appearances: boolean;
  /** Positions Nila may choose between when natural appearances are on. */
  enabled_positions: PositionPreset[];
  /** Which monitor Nila appears on. */
  monitor_mode: MonitorMode;
  /** Monitor index when monitor_mode is "specific". */
  monitor_index: number;
  /** Last user-dragged position (physical px). Null when never dragged. */
  presence_pos: SavedPresencePos | null;
}

/** Where Nila appears: a 3x3 grid over the desktop. */
export type PositionPreset =
  | "top-left"
  | "top"
  | "top-right"
  | "left"
  | "center"
  | "right"
  | "bottom-left"
  | "bottom"
  | "bottom-right";

export const POSITION_PRESETS: PositionPreset[] = [
  "top-left", "top", "top-right",
  "left", "center", "right",
  "bottom-left", "bottom", "bottom-right",
];

/** How Nila enters the screen. */
export type EntranceBehavior = "fade" | "slide" | "pop" | "peek" | "bounce" | "gentle";

/** How Nila leaves the screen. */
export type ExitBehavior = "fade" | "slide" | "retreat" | "peek-out";

/** What Nila does when nothing is happening. */
export type IdlePresence =
  | "visible"
  | "mostly-visible"
  | "partially-hidden"
  | "peek-from-edge"
  | "hidden"
  | "gentle-idle";

/** Which monitor Nila appears on. */
export type MonitorMode = "main" | "current" | "remember" | "specific";

/** Persisted drag position (physical pixels) + context. */
export interface SavedPresencePos {
  x: number;
  y: number;
  monitor: number;
  preset: PositionPreset;
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
  reminder_behavior: "dock",
  desktop_notifications: true,
  idle_behavior: "normal",
  accent: "teal",
  // Presence defaults (spec 51): predictable and calm.
  position_preset: "bottom-right",
  entrance: "gentle",
  exit_behavior: "retreat",
  idle_presence: "mostly-visible",
  peek_amount: 0.35,
  edge_offset: 12,
  tilt: 0,
  top_hang: false,
  entrance_ms: 350,
  exit_ms: 300,
  draggable: true,
  snap_enabled: true,
  snap_threshold: 24,
  natural_appearances: false,
  enabled_positions: ["bottom-right", "right", "top-right"],
  monitor_mode: "main",
  monitor_index: 0,
  presence_pos: null,
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
