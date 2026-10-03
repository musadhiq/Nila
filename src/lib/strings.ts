/**
 * Nila's words.
 *
 * Nila speaks **Manglish** — Malayalam in Latin script, the way friends
 * text each other in Kerala. All reminder messages, overlay buttons and
 * greetings are Manglish.
 *
 * The settings experience is bilingual (English / Manglish) and lives in
 * `lib/i18n.ts` — a centralized dictionary. This module keeps Nila's
 * voice: the words she says, not the words about her.
 */

/** Overlay action buttons (Manglish). */
export const ACTIONS = {
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
  stretch: [
    "Onnu ezhunneettu stretch cheyyamo?",
    "Tholukal onnu vilichu neettam.",
  ],
  exercise: [
    "Onnu exercise cheyyan samayayi!",
    "Kurachu neram body onnu anakkam.",
  ],
  work: [
    "Joli thudangan samayayi.",
    "Focus cheyyam, phone maatti vekkam.",
  ],
  sleep: [
    "Ini kurachu visramikkam.",
    "Urangaan samayayille?",
  ],
};

/** Built-in reminder titles (Manglish). */
export const BUILT_IN_TITLES: Record<string, string> = {
  water: "Vellam",
  food: "Bhakshanam",
  break: "Visramam",
  move: "Nadatham",
  stretch: "Stretch",
  exercise: "Vyayamam",
  work: "Joli",
  sleep: "Urakkam",
};
