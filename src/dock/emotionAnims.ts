/**
 * Animated emotion loops for the notification dock.
 *
 * Each expression slot maps to a looping APNG generated from Nila's
 * emotion videos (see character/emotions/). An <img> plays APNG
 * natively, so DockNilaFigure animates with zero code changes — it
 * just receives an animated src.
 *
 * Under reduced motion (or if an APNG is missing), callers fall back
 * to the static PNG via expressionUrl().
 */
import waveHelloUrl from "../../character/emotions/wave-hello.apng";
import idleUrl from "../../character/emotions/idle.apng";
import happyUrl from "../../character/emotions/happy.apng";
import nudgeUrl from "../../character/emotions/nudge.apng";
import hungryUrl from "../../character/emotions/hungry.apng";
import thirstyUrl from "../../character/emotions/thirsty.apng";
import stretchUrl from "../../character/emotions/stretch.apng";
import energeticUrl from "../../character/emotions/energetic.apng";
import focusedUrl from "../../character/emotions/focused.apng";
import thumbsupUrl from "../../character/emotions/thumbsup.apng";
import angryUrl from "../../character/emotions/angry.apng";
import sadUrl from "../../character/emotions/sad.apng";
import sleepyUrl from "../../character/emotions/sleepy.apng";
import type { ExpressionSlot } from "./expressionSlots";

const EMOTION_ANIMS: Record<ExpressionSlot, string> = {
  greeting: waveHelloUrl,
  hungry: hungryUrl,
  thirsty: thirstyUrl,
  stretching: stretchUrl,
  sleepy: sleepyUrl,
  energetic: energeticUrl,
  relaxed: idleUrl,
  focused: focusedUrl,
  pointing: nudgeUrl,
  happy: happyUrl,
  sad: sadUrl,
  annoyed: angryUrl,
  acknowledge: thumbsupUrl,
};

/** Looping APNG for an expression slot. */
export function emotionAnimUrl(slot: ExpressionSlot): string {
  return EMOTION_ANIMS[slot];
}
