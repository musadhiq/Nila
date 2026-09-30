// Gentle notification chime, synthesized with WebAudio.
//
// No audio assets to ship: two soft sine notes (E5 -> B5) with a slow
// attack and long smooth decay, so the reminder arrives as a warm bell
// rather than a beep. Works fully offline; safe to call when AudioContext
// is unavailable (quiet no-op).

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    if (typeof window === "undefined" || !("AudioContext" in window)) return null;
    if (!ctx) ctx = new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function note(
  ac: AudioContext,
  freq: number,
  t0: number,
  duration: number,
  peak: number,
): void {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  // Smooth attack (~40ms) then an exponential decay to silence.
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.04);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(gain);
  gain.connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.05);
}

/** Play the reminder chime. `style` mirrors the settings sound choice. */
export function playReminderChime(style: "soft" | "chime"): void {
  const ac = audio();
  if (!ac) return;
  const t = ac.currentTime + 0.03;
  if (style === "soft") {
    // One breath of a note.
    note(ac, 659.25, t, 1.0, 0.1); // E5
    return;
  }
  // The default chime: E5 blooming into B5, overlapping for smoothness.
  note(ac, 659.25, t, 1.2, 0.12); // E5
  note(ac, 987.77, t + 0.24, 1.5, 0.1); // B5
}
