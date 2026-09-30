// Malayalam UI copy. The application UI is Malayalam-only (V1 scope);
// user-entered custom reminder text may contain Malayalam and English.

export const ACTIONS = {
  later: "പിന്നീട്",
  ok: "ശരി",
  dismiss: "ഒഴിവാക്കുക",
  snooze10: "10 മിനിറ്റ് കഴിഞ്ഞ്",
  snooze30: "30 മിനിറ്റ് കഴിഞ്ഞ്",
  snooze60: "1 മണിക്കൂർ കഴിഞ്ഞ്",
  pause30: "30 മിനിറ്റ് നിർത്തുക",
  pause60: "1 മണിക്കൂർ നിർത്തുക",
  pauseTomorrow: "നാളെ വരെ നിർത്തുക",
  resume: "തുടരുക",
  settings: "ക്രമീകരണം",
  testReminder: "ഒരു reminder പരീക്ഷിക്കുക",
  save: "സൂക്ഷിക്കുക",
  cancel: "റദ്ദാക്കുക",
  delete: "മായ്ക്കുക",
  edit: "തിരുത്തുക",
  add: "ചേർക്കുക",
} as const;

export const BUILT_IN_MESSAGES: Record<string, string[]> = {
  water: [
    "വെള്ളം കുടിച്ചോ?",
    "കുറച്ച് വെള്ളം കുടിക്കാം?",
    "ഒരു ഗ്ലാസ് വെള്ളം ആയാലോ?",
  ],
  food: [
    "ഭക്ഷണം കഴിച്ചോ?",
    "ഭക്ഷണം കഴിക്കാൻ സമയമായി.",
  ],
  break: [
    "കുറച്ച് നേരം വിശ്രമിച്ചാലോ?",
    "സ്ക്രീനിൽ നിന്ന് കുറച്ച് നേരം മാറിയിരിക്കാം.",
  ],
  move: [
    "ഒന്ന് എഴുന്നേറ്റ് നടക്കാമോ?",
    "കുറച്ച് stretch ചെയ്യാം.",
  ],
  sleep: [
    "ഇനി കുറച്ച് വിശ്രമിക്കാം.",
    "ഉറങ്ങാൻ സമയമായില്ലേ?",
  ],
};

export const BUILT_IN_TITLES: Record<string, string> = {
  water: "വെള്ളം",
  food: "ഭക്ഷണം",
  break: "വിശ്രമം",
  move: "നടത്തം",
  sleep: "ഉറക്കം",
};

export const ONBOARDING = {
  hello: "ഹായ് 👋",
  intro:
    "ഞാൻ നില! നിങ്ങളെ സഹായിക്കാൻ വന്ന ഒരു ചെറിയ കൂട്ടുകാരി. " +
    "വെള്ളം കുടിക്കാനും വിശ്രമിക്കാനും ഞാൻ സ്നേഹത്തോടെ ഓർമ്മിപ്പിക്കാം.",
  chooseReminders: "ഏതൊക്കെ ഓർമ്മപ്പെടുത്തലുകൾ വേണം?",
  schedule: "എപ്പോഴൊക്കെ ഓർമ്മിപ്പിക്കണം?",
  appearance: "എന്നെ എങ്ങനെ കാണണം?",
  finish: "ശരി, തുടങ്ങാം!",
} as const;

export const SETTINGS_LABELS = {
  general: "പൊതുവായത്",
  reminders: "ഓർമ്മപ്പെടുത്തലുകൾ",
  character: "കഥാപാത്രം",
  appearance: "രൂപം",
  schedule: "സമയം",
  about: "വിവരം",
  quietHours: "ശാന്ത സമയം",
  dailyLimit: "ദിവസ പരിധി",
  cooldown: "ഇടവേള",
  startAtLogin: "കമ്പ്യൂട്ടർ ഓൺ ആകുമ്പോൾ തുടങ്ങുക",
  showCharacter: "കഥാപാത്രത്തെ കാണിക്കുക",
  sizeSmall: "ചെറുത്",
  sizeMedium: "ഇടത്തരം",
  sizeLarge: "വലുത്",
  animationFull: "പൂർണ്ണം",
  animationReduced: "കുറച്ചത്",
  animationOff: "ഒഴിവാക്കുക",
  themeSystem: "സിസ്റ്റം",
  themeLight: "വെളിച്ചം",
  themeDark: "ഇരുട്ട്",
  sound: "ശബ്ദം",
  soundNone: "ഇല്ല",
  soundSoft: "മൃദുവായത്",
  soundChime: "മണിനാദം",
  dataSection: "വിവരങ്ങൾ",
  exportData: "ബാക്കപ്പ് എടുക്കുക",
  importData: "ബാക്കപ്പ് തിരിച്ചെടുക്കുക",
  exported: "ബാക്കപ്പ് സൂക്ഷിച്ചു.",
  imported: "ബാക്കപ്പ് തിരിച്ചെടുത്തു.",
} as const;

export const ERRORS = {
  generic: "എന്തോ തെറ്റ് സംഭവിച്ചു. ദയവായി വീണ്ടും ശ്രമിക്കൂ.",
  noTray: "സിസ്റ്റം ട്രേ കണ്ടെത്തിയില്ല.",
  importFailed: "ഫയൽ വായിക്കാൻ കഴിഞ്ഞില്ല.",
  exportFailed: "ബാക്കപ്പ് എടുക്കാൻ കഴിഞ്ഞില്ല.",
  importInvalid: "ഈ ഫയൽ നിലയുടെ ബാക്കപ്പ് അല്ല.",
} as const;

/** Pick a message variant deterministically-ish (rotates by count). */
export function pickVariant(kind: string, count: number): string {
  const variants = BUILT_IN_MESSAGES[kind];
  if (!variants || variants.length === 0) return "";
  return variants[count % variants.length];
}
