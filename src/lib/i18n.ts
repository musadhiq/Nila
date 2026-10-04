/**
 * Nila's settings language system — intentionally simple.
 *
 * Two languages, one centralized dictionary:
 *   - "en"       — English, the primary UI language.
 *   - "manglish" — Malayalam in Latin script, first-class, conversational
 *                  (never word-for-word translations).
 *
 * Nila's *voice* (reminder copy, overlay buttons, greetings) stays Manglish
 * always — see `strings.ts`. This dictionary covers the settings/management
 * UI only. No localization framework, no message formatting library: plain
 * nested objects plus a tiny `{placeholder}` filler.
 */
import type { Schedule } from "./types";

export type Language = "en" | "manglish";

const en = {
  window: {
    title: "Nila Settings",
    quietActive: "Quiet hours until {time} — reminders are paused",
  },
  companion: {
  },
  dock: {
    greeting: "Hi! I'll pop up here whenever there's a reminder.",
    okay: "Okay, Nila",
    in10min: "In 10 min",
    nilaAlt: "Nila peeking over the notification",
  },
  wake: {
    nilaAlt: "Nila waving hello",
  },
  nav: {
    welcome: "Welcome",
    general: "General",
    nila: "Nila",
    reminders: "Reminders",
    appearance: "Appearance",
    accessibility: "Accessibility",
    about: "About",
  },
  page: {
    welcome: {
      title: "Welcome",
      subtitle: "Let's get Nila set up on your desktop.",
    },
    general: {
      title: "General",
      subtitle: "Make Nila work the way you like.",
    },
    nila: {
      title: "Nila",
      subtitle: "Customize how Nila appears and reacts.",
    },
    reminders: {
      title: "Reminders",
      subtitle: "Choose what Nila can remind you about.",
    },
    appearance: {
      title: "Appearance",
      subtitle: "Adjust how Nila looks on your desktop.",
    },
    accessibility: {
      title: "Accessibility",
      subtitle: "Motion and sound, tuned to your comfort.",
    },
    about: {
      title: "About",
      subtitle: "A little companion for your day.",
    },
  },
  welcome: {
    headline: "Hi, I'm Nila.",
    intro:
      "I'll gently remind you about the little things that matter during your day.",
    step1Title: "A gentle companion",
    step1Text:
      "Nila lives in your top bar and only appears when there's something worth your attention.",
    step2Title: "Reminders that feel kind",
    step2Text:
      "A small card slides in at the top of your screen. Tap the tick when you're done, or snooze it for later.",
    step3Title: "Yours to shape",
    step3Text:
      "Pick a language, theme and accent. Everything stays on your machine.",
    languageLabel: "Language",
    createFirst: "Create your first reminder",
    continue: "Continue",
  },
  general: {
    behaviorSection: "Nila behavior",
    startAtLogin: "Start Nila at login",
    startAtLoginDesc: "Nila will appear automatically when you sign in.",
    wakeWord: "Wake word",
    wakeWordDesc: "Say “Hi Nila” and she'll pop up to wave hello.",
    pauseSection: "Pause reminders",
    pauseDesc: "Take a break from reminders for a while.",
    pause30: "30 minutes",
    pause60: "1 hour",
    pauseTomorrow: "Until tomorrow",
    resume: "Resume reminders",
    pausedUntil: "Paused until {time}",
    testSection: "Try it out",
    testReminder: "Try a reminder",
    testReminderDesc: "See how a reminder looks and sounds.",
    backupSection: "Backup",
    backupDesc: "Keep a copy of your reminders and settings.",
    export: "Export backup",
    import: "Import backup",
    exported: "Backup saved.",
    imported: "Backup restored ({count} reminders).",
  },
  reminders: {
    builtInSection: "Built-in reminders",
    customSection: "Custom reminders",
    systemSection: "System reminders",
    syscalTitle: "System calendar",
    syscalDesc: "Create reminders from your desktop calendar (GNOME Calendar, Evolution).",
    syscalNoCalendars: "No calendars found on this system.",
    syscalActive: "Syncing {count} calendar(s). Reminders fire 15 minutes before events.",
    syscalWorking: "Working…",
    newReminder: "New reminder",
    emptyCustom: "No custom reminders yet.",
    emptyCustomDesc:
      "Create one when you want Nila to remember something for you.",
    editHint: "Select a reminder to change its schedule.",
    nextTitle: "Next reminder",
    nextNone: "No upcoming reminders.",
    nextInMinutes: "in {minutes} min",
    nextInHours: "in {hours} hr",
    nextInDays: "in {days} days",
    dataIssue: "Some saved reminders need attention — they will not fire until fixed.",
    enabled: "Enabled",
    editor: {
      newTitle: "New reminder",
      editTitle: "Edit reminder",
      titleLabel: "Title",
      titlePlaceholder: "Drink water",
      messageLabel: "Message",
      messagePlaceholder: "Time for some water",
      typeLabel: "Type",
      scheduleLabel: "Schedule",
      scheduleDaily: "Daily",
      scheduleWeekly: "Weekly",
      scheduleInterval: "Every X minutes",
      scheduleOnce: "Once",
      timeLabel: "Time",
      daysLabel: "Days",
      minutesLabel: "Every",
      minutesUnit: "minutes",
      onceLabel: "Date and time",
      onceDateLabel: "Date",
      onceTimeLabel: "Time",
      save: "Save reminder",
      cancel: "Cancel",
      delete: "Delete reminder",
      deleteConfirm: "Delete this reminder? This can't be undone.",
      keepEditing: "Keep editing",
      yesDelete: "Delete",
      titleRequired: "Please add a title.",
      messageRequired: "Please add a message.",
      scheduleRequired: "Please choose when it should repeat.",
      pastError: "That time has already passed — pick a time in the future.",
      kind: {
        water: "Water",
        food: "Food",
        break: "Break",
        move: "Movement",
        stretch: "Stretch",
        exercise: "Exercise",
        work: "Work / Study",
        sleep: "Sleep",
        battery: "Battery",
        cpu: "CPU load",
        memory: "Memory",
        disk: "Disk space",
        custom: "Custom",
      } as Record<string, string>,
    },
    schedule: {
      once: "Once · {at}",
      daily: "Daily · {time}",
      weekly: "{days} · {time}",
      interval: "Every {minutes} min",
      system: {
        battery_low: "When battery drops below 20%",
        cpu_high: "When CPU load stays above 85%",
        memory_high: "When memory runs low",
        disk_low: "When disk space runs low",
      },
      daysShort: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    },
  },
  character: {
    sizeSection: "Character size",
    sizeDesc: "How big Nila appears on your desktop.",
    sizeSmall: "Small",
    sizeMedium: "Medium",
    sizeLarge: "Large",
    idleSection: "Idle behavior",
    idleDesc: "What Nila does while waiting.",
    idleNormal: "Normal",
    idleNormalDesc: "Nila breathes and looks around gently.",
    idleMinimal: "Minimal",
    idleMinimalDesc: "Nila stays still when idle.",
    visibilitySection: "Visibility",
    visibilityDesc: "When Nila appears on your desktop.",
    visibilityAlways: "Always visible",
    visibilityAlwaysDesc: "Nila stays on screen, quietly part of your day.",
    visibilityReminding: "Only when reminding",
    visibilityRemindingDesc:
      "Nila appears when a reminder is due, then slips back into the tray.",
    visibilityHidden: "Hidden",
    visibilityHiddenDesc:
      "Nila lives in the tray; reminders arrive as system notifications.",
    dockSection: "Notification dock",
    dockDesc:
      "When a reminder is due, Nila appears in a small dock at the top center of your screen. The rest of the time she stays in the tray.",
    previewSection: "Preview notifications",
    previewDesc: "Try the notification dock. Development only.",
    previewShort: "Show notification",
    previewLong: "Show long notification",
    previewQueue: "Queue three notifications",
    appearanceSection: "Appearance",
    behaviorSection: "Behavior",
  },
  appearance: {
    themeSection: "Theme",
    themeDesc: "Follow your system, or pick one.",
    themeSystem: "System",
    themeLight: "Light",
    themeDark: "Dark",
    accentSection: "Accent color",
    accentDesc: "A quiet touch of color across settings.",
    accentTeal: "Lagoon",
    accentAmber: "Marigold",
    accentRose: "Rose",
    accentIndigo: "Indigo",
  },
  accessibility: {
    motionSection: "Motion",
    motionDesc:
      "Control how much Nila moves. Reduced keeps a calmer rhythm; Off keeps her still.",
    motionFull: "Full",
    motionReduced: "Reduced",
    motionOff: "Off",
  },
  schedule: {
    quietSection: "Quiet hours",
    quietDesc: "Nila won't remind you during these hours.",
    quietStart: "Quiet hours start",
    quietEnd: "Quiet hours end",
    limitSection: "Daily reminder limit",
    limitDesc: "The most reminders Nila will show each day.",
    limitValue: "{count} reminders",
    cooldownSection: "Minimum time between reminders",
    cooldownDesc: "Nila waits at least this long between reminders.",
    cooldownValue: "{count} minutes",
  },
  notifications: {
    soundSection: "Sound",
    soundTitle: "Sound",
    soundDesc: "Play a gentle sound when a reminder appears.",
    soundNone: "None",
    soundSoft: "Soft",
    soundGentle: "Gentle",
  },
  languagePage: {
    section: "Language",
    english: "English",
    englishDesc: "The primary language for settings.",
    manglish: "Manglish",
    manglishDesc: "Malayalam in Latin script, the way we text.",
  },
  about: {
    version: "Version {version}",
    versionLabel: "Version",
    tagline: "A little companion for your day.",
    documentation: "Documentation",
    documentationValue: "README and the docs/ folder",
    licenses: "Licenses",
    licensesValue: "Apache-2.0 (code)",
    github: "GitHub",
    githubValue: "github.com/musadhiq/Nila",
    author: "Author",
    authorValue: "musadhiq",
    authorUrl: "https://github.com/musadhiq",
    madeFor: "Made for Linux",
    helpSection: "Help",
    welcomeTour: "Welcome to Nila",
    welcomeTourDesc: "Replay the short first-run tour.",
  },
  common: {
    on: "On",
    off: "Off",
    close: "Close",
    back: "Back",
    save: "Save",
    cancel: "Cancel",
    delete: "Delete",
    add: "Add",
    done: "Done",
  },
  errors: {
    generic: "Something went wrong. Please try again.",
    exportFailed: "Couldn't create the backup.",
    importFailed: "Couldn't read the file.",
    importInvalid: "This file is not a Nila backup.",
  },
};

export type Dict = typeof en;

const manglish: Dict = {
  window: {
    title: "Nila Settings",
    quietActive: "Quiet hours {time} vare — reminders niruthi vachu",
  },
  companion: {
  },
  dock: {
    greeting: "Hi! Orma undel njan ivide varum.",
    okay: "Sheri, Nila",
    in10min: "10 minute kazhinj",
    nilaAlt: "Notification-nokkiya Nila",
  },
  wake: {
    nilaAlt: "Kai veeshunna Nila",
  },
  nav: {
    welcome: "Welcome",
    general: "General",
    nila: "Nila",
    reminders: "Reminders",
    appearance: "Appearance",
    accessibility: "Accessibility",
    about: "About",
  },
  page: {
    welcome: {
      title: "Swagatham",
      subtitle: "Nila-ye ninte desktop-il set cheyyam.",
    },
    general: {
      title: "General",
      subtitle: "Nila ninte ishtam pole work cheyyatte.",
    },
    nila: {
      title: "Nila",
      subtitle: "Nila eppozhaanu kaanunnathu, engane react cheyyunnathu — ivide set cheyyam.",
    },
    reminders: {
      title: "Reminders",
      subtitle: "Ethokke karyangal Nila ormmippikkanamennu theerumanikku.",
    },
    appearance: {
      title: "Appearance",
      subtitle: "Desktop-il Nila-yude look ivide adjust cheyyam.",
    },
    accessibility: {
      title: "Accessibility",
      subtitle: "Motion-um sound-um ninte comfort-inu.",
    },
    about: {
      title: "About",
      subtitle: "Ninte divasathilekku oru cheriya koottukari.",
    },
  },
  welcome: {
    headline: "Hi, njan Nila.",
    intro:
      "Ninte divasathe cheriya karyangal njan gently ormmippichu tharum.",
    step1Title: "Oru gentle koottukari",
    step1Text:
      "Nila top bar-il jeevikkum; shradhikkendathu ondu vannaal mathrame screen-il varoo.",
    step2Title: "Kind reminders",
    step2Text:
      "Screen-inde mukalil oru cheriya card varum. Kazhinjal tick cheyyu, allenkil pinneekku snooze cheyyu.",
    step3Title: "Ninte ishtam pole",
    step3Text:
      "Language, theme, accent — ivide select cheyyu. Ellam ninte machine-il thanne.",
    languageLabel: "Bhasha",
    createFirst: "Ninte adya reminder undakkuka",
    continue: "Thudaruka",
  },
  general: {
    behaviorSection: "Nila behavior",
    startAtLogin: "Login-il Nila start cheyyuka",
    startAtLoginDesc: "Sign in cheyyumbol Nila thanne varum.",
    wakeWord: "Wake word",
    wakeWordDesc: "“Hi Nila” ennu paranjaal aval vannu kai veeshum.",
    pauseSection: "Reminders nirthuka",
    pauseDesc: "Kurachu nerathekk reminders venda.",
    pause30: "30 minute",
    pause60: "1 manikkoor",
    pauseTomorrow: "Naale vare",
    resume: "Reminders thudanguka",
    pausedUntil: "{time} vare nirthi vechirikkunnu",
    testSection: "Onnu try cheyyu",
    testReminder: "Oru reminder try cheyyu",
    testReminderDesc: "Reminder eppozhaanu kaanunnathu, sound engane — onnu kandu nokku.",
    backupSection: "Backup",
    backupDesc: "Reminders-um settings-um oru copy aayi save cheyyam.",
    export: "Backup export cheyyuka",
    import: "Backup import cheyyuka",
    exported: "Backup save aayi.",
    imported: "Backup restore aayi ({count} reminders).",
  },
  reminders: {
    builtInSection: "Built-in reminders",
    customSection: "Custom reminders",
    systemSection: "System reminders",
    syscalTitle: "System calendar",
    syscalDesc: "Desktop calendar-il (GNOME Calendar, Evolution) ninnum reminders undaakku.",
    syscalNoCalendars: "Ee system-il calendar onnum kandilla.",
    syscalActive: "{count} calendar sync cheyyunnu. Event-nu 15 minutes-nu munne reminder varum.",
    syscalWorking: "Working…",
    newReminder: "Puthiya reminder",
    emptyCustom: "Custom reminders onnum illa.",
    emptyCustomDesc: "Nila ethengilum ormmikkanamennu thonnumbol ivide create cheyyam.",
    editHint: "Schedule maattana menkil oru reminder select cheyyu.",
    nextTitle: "Adutha reminder",
    nextNone: "Adutha reminder onnum illa.",
    nextInMinutes: "{minutes} minute kazhinj",
    nextInHours: "{hours} manikkoor kazhinj",
    nextInDays: "{days} divasam kazhinj",
    dataIssue: "Chila saved reminders shariyalla — onnu nokkiyittu shariyakku.",
    enabled: "Enabled",
    editor: {
      newTitle: "Puthiya reminder",
      editTitle: "Reminder edit cheyyuka",
      titleLabel: "Title",
      titlePlaceholder: "Vellam kudikkuka",
      messageLabel: "Message",
      messagePlaceholder: "Vellam kudikkan samayayi",
      typeLabel: "Type",
      scheduleLabel: "Schedule",
      scheduleDaily: "Dinasavum",
      scheduleWeekly: "Aazhchayil",
      scheduleInterval: "X minute-koodumbol",
      scheduleOnce: "Oru thavana",
      timeLabel: "Samayam",
      daysLabel: "Divasangal",
      minutesLabel: "Ethra",
      minutesUnit: "minute-koodumbol",
      onceLabel: "Date-um samayavum",
      onceDateLabel: "Theeyathi",
      onceTimeLabel: "Samayam",
      save: "Reminder save cheyyuka",
      cancel: "Cancel",
      delete: "Reminder delete cheyyuka",
      deleteConfirm: "Ee reminder delete cheyyatte? Thirinju kittilla.",
      keepEditing: "Keep editing",
      yesDelete: "Delete",
      titleRequired: "Oru title kodukku.",
      messageRequired: "Oru message ezhuthu.",
      scheduleRequired: "Eppozhokke repeat cheyyanamen nu theerumanikku.",
      pastError: "Aa samayam kazhinju poyi — bhaviyilulla samayam theranjedukku.",
      kind: {
        water: "Vellam",
        food: "Bhakshanam",
        break: "Visramam",
        move: "Nadatham",
        stretch: "Stretch",
        exercise: "Vyayamam",
        work: "Joli",
        sleep: "Urakkam",
        battery: "Battery",
        cpu: "CPU load",
        memory: "Memory",
        disk: "Disk space",
        custom: "Custom",
      } as Record<string, string>,
    },
    schedule: {
      once: "Oru thavana · {at}",
      daily: "Dinasavum · {time}",
      weekly: "{days} · {time}",
      interval: "{minutes} minute-koodumbol",
      system: {
        battery_low: "Battery 20%-ilum kurayumbol",
        cpu_high: "CPU load 85%-ilum koodumbol",
        memory_high: "Memory kurayumbol",
        disk_low: "Disk space kurayumbol",
      },
      daysShort: ["Nja", "Thi", "Cho", "Bud", "Vya", "Vel", "Sha"],
    },
  },
  character: {
    sizeSection: "Character size",
    sizeDesc: "Desktop-il Nila ethra valuthayi kaananam.",
    sizeSmall: "Cheriya",
    sizeMedium: "Midiyam",
    sizeLarge: "Valiya",
    idleSection: "Idle behavior",
    idleDesc: "Nila summa irikkumbol enthu cheyyanam.",
    idleNormal: "Normal",
    idleNormalDesc: "Nila gently breathe cheythum chuttum nokkiyum irikkum.",
    idleMinimal: "Minimal",
    idleMinimalDesc: "Idle aayirikkumbol Nila anangathe irikkum.",
    visibilitySection: "Visibility",
    visibilityDesc: "Nila desktopil eppozha varunnathu.",
    visibilityAlways: "Eppozhum kananam",
    visibilityAlwaysDesc: "Nila scree'nil thanne undakum, ningalude divasathinte koode.",
    visibilityReminding: "Ormmippikku mbozha mathram",
    visibilityRemindingDesc:
      "Ormmappeduthal vannal Nila varum, pinne trayilekku thirike pokum.",
    visibilityHidden: "Olikkuka",
    visibilityHiddenDesc:
      "Nila trayil aanu; ormmappeduthalukal system notification ayi varum.",
    dockSection: "Notification dock",
    dockDesc:
      "Orma vannal, Nila screen-inte mukalil cheriya oru dock-il varum. Bakki samayam tray-yil thanne irikkum.",
    previewSection: "Preview notifications",
    previewDesc: "Notification dock onnu try cheyyu. Developmentinu mathram.",
    previewShort: "Notification kanikkuka",
    previewLong: "Long notification kanikkuka",
    previewQueue: "Moonnu notification queue cheyyuka",
    appearanceSection: "Appearance",
    behaviorSection: "Behavior",
  },
  appearance: {
    themeSection: "Theme",
    themeDesc: "System follow cheyyu, allenkil ninte ishtam theerumanikku.",
    themeSystem: "System",
    themeLight: "Light",
    themeDark: "Dark",
    accentSection: "Accent color",
    accentDesc: "Settings-il oru cheriya color touch.",
    accentTeal: "Lagoon",
    accentAmber: "Marigold",
    accentRose: "Rose",
    accentIndigo: "Indigo",
  },
  accessibility: {
    motionSection: "Motion",
    motionDesc:
      "Nila ethra move cheyyanamennu theerumanikku. Reduced calm aayirikkum; Off ava anangathe irikkum.",
    motionFull: "Full",
    motionReduced: "Reduced",
    motionOff: "Off",
  },
  schedule: {
    quietSection: "Quiet hours",
    quietDesc: "Ee samayathu Nila ormmippikkilla.",
    quietStart: "Quiet hours thudakkam",
    quietEnd: "Quiet hours avassanam",
    limitSection: "Daily reminder limit",
    limitDesc: "Oru divasam Nila kanikkunna maximum reminders.",
    limitValue: "{count} reminders",
    cooldownSection: "Reminders thammilulla minimum gap",
    cooldownDesc: "Reminders-kkidayil Nila ingane wait cheyyum.",
    cooldownValue: "{count} minute",
  },
  notifications: {
    soundSection: "Sound",
    soundTitle: "Sound",
    soundDesc: "Reminder varumbol oru gentle sound kalikkum.",
    soundNone: "Venda",
    soundSoft: "Soft",
    soundGentle: "Gentle",
  },
  languagePage: {
    section: "Language",
    english: "English",
    englishDesc: "Settings-inte primary language.",
    manglish: "Manglish",
    manglishDesc: "Latin script-il ezhuthunna Malayalam.",
  },
  about: {
    version: "Version {version}",
    versionLabel: "Version",
    tagline: "Ninte divasathilekku oru cheriya koottukari.",
    documentation: "Documentation",
    documentationValue: "README-um docs/ folder-um",
    licenses: "Licenses",
    licensesValue: "Apache-2.0 (code)",
    github: "GitHub",
    githubValue: "github.com/musadhiq/Nila",
    author: "Author",
    authorValue: "musadhiq",
    authorUrl: "https://github.com/musadhiq",
    madeFor: "Linux-nu vendi",
    helpSection: "Help",
    welcomeTour: "Welcome to Nila",
    welcomeTourDesc: "Adya tour veendum kaanam.",
  },
  common: {
    on: "On",
    off: "Off",
    close: "Close",
    back: "Back",
    save: "Save",
    cancel: "Cancel",
    delete: "Delete",
    add: "Add",
    done: "Sheri",
  },
  errors: {
    generic: "Enthengilum thettu patti. Onnu koodi try cheyyu.",
    exportFailed: "Backup undakkan pattiyilla.",
    importFailed: "File vayikkan pattiyilla.",
    importInvalid: "Ithu Nila backup alla.",
  },
};

/** The full settings dictionary for both languages. */
export const STRINGS: Record<Language, Dict> = { en, manglish };

/** Get the dictionary for a language (falls back to English). */
export function getStrings(lang: Language): Dict {
  return STRINGS[lang] ?? STRINGS.en;
}

/** Fill `{placeholder}` values in a template string. */
export function fill(
  template: string,
  vars: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) =>
    key in vars ? String(vars[key]) : `{${key}}`,
  );
}

/** Localized one-line description of a schedule, for reminder list rows. */
export function describeScheduleIn(s: Schedule, lang: Language): string {
  const t = getStrings(lang).reminders.schedule;
  switch (s.type) {
    case "once":
      return fill(t.once, { at: formatLocalDateTime(s.at) });
    case "daily":
      return fill(t.daily, { time: s.time });
    case "weekly": {
      const days = s.days
        .map((d) => t.daysShort[d] ?? "")
        .filter(Boolean)
        .join(", ");
      return fill(t.weekly, { days: days || "—", time: s.time });
    }
    case "interval":
      return fill(t.interval, { minutes: s.minutes });
    case "system":
      return t.system[s.metric];
  }
}

/**
 * Format an ISO instant in the user's local timezone for display,
 * e.g. "2 Oct 2026, 3:30 pm". Both UI languages use Latin script, so a
 * single en-IN style keeps dates readable for English and Manglish.
 * Returns the input unchanged when it isn't a valid instant.
 */
export function formatLocalDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/**
 * Localized "next in …" label for a future ISO timestamp (the scheduler's
 * next deadline). Returns null when the timestamp is missing, invalid,
 * or not in the future. Pure — the scheduler owns the computation, the
 * UI only formats what the backend reported.
 */
export function formatNextIn(
  atIso: string | null | undefined,
  lang: Language,
  nowMs: number = Date.now(),
): string | null {
  if (!atIso) return null;
  const at = Date.parse(atIso);
  if (Number.isNaN(at)) return null;
  const mins = Math.round((at - nowMs) / 60000);
  if (mins < 1) return null;
  const t = getStrings(lang).reminders;
  if (mins < 60) return fill(t.nextInMinutes, { minutes: mins });
  const hours = Math.round(mins / 60);
  if (hours < 48) return fill(t.nextInHours, { hours });
  return fill(t.nextInDays, { days: Math.round(hours / 24) });
}
