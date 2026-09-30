/**
 * Nila's words.
 *
 * Nila speaks **Manglish** — Malayalam in Latin script, the way friends
 * text each other in Kerala. All reminder messages, overlay buttons and
 * greetings are Manglish.
 *
 * The settings / reminders panels are a management UI and use plain
 * English so every option is unambiguous.
 */

/** Action buttons. Overlay buttons are Manglish; panel buttons are English. */
export const ACTIONS = {
  // Reminder overlay (Manglish)
  later: "Pinneed",
  ok: "Sheri",
  dismiss: "Ozhivakkuka",
  snooze10: "10 minute kazhinj",
  snooze30: "30 minute kazhinj",
  snooze60: "1 manikkoor kazhinj",
  pause30: "30 minute nirthuka",
  pause60: "1 manikkoor nirthuka",
  pauseTomorrow: "Naale vare nirthuka",
  resume: "Thudaruka",
  // Panels (English)
  settings: "Settings",
  testReminder: "Try a reminder",
  save: "Save",
  cancel: "Cancel",
  delete: "Delete",
  edit: "Edit",
  add: "Add",
} as const;

/** Built-in reminder messages, in Nila's caring Manglish voice. */
export const BUILT_IN_MESSAGES: Record<string, string[]> = {
  water: [
    "Vellam kudicho?",
    "Kurachu vellam kudikkam?",
    "Oru glass vellam ayalo?",
  ],
  food: [
    "Bhakshanam kazhicho?",
    "Bhakshanam kazhikkan samayayi.",
  ],
  break: [
    "Kurachu neram visramichalo?",
    "Screen-il ninnu kurachu neram mariyirikkam.",
  ],
  move: [
    "Onnu ezhunneettu nadakkamo?",
    "Kurachu stretch cheyyam.",
  ],
  sleep: [
    "Ini kurachu visramikkam.",
    "Urangaan samayayille?",
  ],
};

/** Pick a rotating message variant for a reminder kind. */
export function pickVariant(kind: string, index: number): string {
  const variants = BUILT_IN_MESSAGES[kind];
  if (!variants || variants.length === 0) return "";
  return variants[index % variants.length];
}

/** Built-in reminder titles (Manglish). */
export const BUILT_IN_TITLES: Record<string, string> = {
  water: "Vellam",
  food: "Bhakshanam",
  break: "Visramam",
  move: "Nadatham",
  sleep: "Urakkam",
};

/** First-launch greeting (Manglish). */
export const ONBOARDING = {
  hello: "Hi 👋",
  intro:
    "Njan Nila! Ningale sahayikkan vannu oru cheriya koottukari. " +
    "Vellam kudikkanum visramikkanum njan snehathode ormmippikkam.",
  chooseReminders: "Ethokke ormmappeduthalukal venam?",
  schedule: "Eppozhokke ormmippikkanam?",
  appearance: "Enne engane kananam?",
  finish: "Sheri, thudangam!",
} as const;

/** Settings panel labels (plain English). */
export const SETTINGS_LABELS = {
  general: "General",
  reminders: "Reminders",
  character: "Character",
  appearance: "Appearance",
  schedule: "Schedule",
  about: "About",
  quietHours: "Quiet hours",
  dailyLimit: "Daily limit",
  cooldown: "Cooldown",
  startAtLogin: "Start at login",
  showCharacter: "Show character",
  sizeSmall: "Small",
  sizeMedium: "Medium",
  sizeLarge: "Large",
  animationFull: "Full",
  animationReduced: "Reduced",
  animationOff: "Off",
  themeSystem: "System",
  themeLight: "Light",
  themeDark: "Dark",
  sound: "Sound",
  soundNone: "None",
  soundSoft: "Soft",
  soundChime: "Chime",
  dataSection: "Backup",
  exportData: "Export backup",
  importData: "Import backup",
  exported: "Backup saved.",
  imported: "Backup restored.",
} as const;

/** Error messages shown in the panels (plain English). */
export const ERRORS = {
  generic: "Something went wrong. Please try again.",
  noTray: "System tray not found.",
  importFailed: "Couldn't read the file.",
  exportFailed: "Couldn't create the backup.",
  importInvalid: "This file is not a Nila backup.",
} as const;
