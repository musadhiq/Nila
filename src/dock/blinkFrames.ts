/**
 * Expression slot -> blink frame image URLs.
 *
 * The semantic table lives in `expressionSlots.ts` (`SLOT_BLINK_FILENAMES`,
 * PNG-free and tested); this module only binds each slot's half-blink and
 * fully-closed frames to their PNGs. Every slot in `SLOT_BLINK_FILENAMES`
 * must have a binding here — the asset test enforces it.
 */

import annoyedHalfUrl from "../../character/expressions/blink/annoyed_blink_half.png";
import annoyedClosedUrl from "../../character/expressions/blink/annoyed_blink_closed.png";
import curiousHalfUrl from "../../character/expressions/blink/curious_blink_half.png";
import curiousClosedUrl from "../../character/expressions/blink/curious_blink_closed.png";
import energeticHalfUrl from "../../character/expressions/blink/energetic_blink_half.png";
import energeticClosedUrl from "../../character/expressions/blink/energetic_blink_closed.png";
import focusedHalfUrl from "../../character/expressions/blink/focused_blink_half.png";
import focusedClosedUrl from "../../character/expressions/blink/focused_blink_closed.png";
import happyHalfUrl from "../../character/expressions/blink/happy_blink_half.png";
import happyClosedUrl from "../../character/expressions/blink/happy_blink_closed.png";
import hungryHalfUrl from "../../character/expressions/blink/hungry_blink_half.png";
import hungryClosedUrl from "../../character/expressions/blink/hungry_blink_closed.png";
import playfulHalfUrl from "../../character/expressions/blink/playful_blink_half.png";
import playfulClosedUrl from "../../character/expressions/blink/playful_blink_closed.png";
import pointHalfUrl from "../../character/expressions/blink/point_blink_half.png";
import pointClosedUrl from "../../character/expressions/blink/point_blink_closed.png";
import restChinHalfUrl from "../../character/expressions/blink/rest_chin_blink_half.png";
import restChinClosedUrl from "../../character/expressions/blink/rest_chin_blink_closed.png";
import sadHalfUrl from "../../character/expressions/blink/sad_blink_half.png";
import sadClosedUrl from "../../character/expressions/blink/sad_blink_closed.png";
import sleepyHalfUrl from "../../character/expressions/blink/sleepy_blink_half.png";
import sleepyClosedUrl from "../../character/expressions/blink/sleepy_blink_closed.png";
import stretchingHalfUrl from "../../character/expressions/blink/stretching_blink_half.png";
import stretchingClosedUrl from "../../character/expressions/blink/stretching_blink_closed.png";
import thirstyHalfUrl from "../../character/expressions/blink/thirsty_blink_half.png";
import thirstyClosedUrl from "../../character/expressions/blink/thirsty_blink_closed.png";
import type { ExpressionSlot } from "./expressionSlots";

export interface BlinkFrameUrls {
  half: string;
  closed: string;
}

const BLINK_FRAME_URLS: Record<ExpressionSlot, BlinkFrameUrls> = {
  greeting: { half: curiousHalfUrl, closed: curiousClosedUrl },
  hungry: { half: hungryHalfUrl, closed: hungryClosedUrl },
  thirsty: { half: thirstyHalfUrl, closed: thirstyClosedUrl },
  stretching: { half: stretchingHalfUrl, closed: stretchingClosedUrl },
  sleepy: { half: sleepyHalfUrl, closed: sleepyClosedUrl },
  energetic: { half: energeticHalfUrl, closed: energeticClosedUrl },
  relaxed: { half: restChinHalfUrl, closed: restChinClosedUrl },
  focused: { half: focusedHalfUrl, closed: focusedClosedUrl },
  pointing: { half: pointHalfUrl, closed: pointClosedUrl },
  playful: { half: playfulHalfUrl, closed: playfulClosedUrl },
  happy: { half: happyHalfUrl, closed: happyClosedUrl },
  sad: { half: sadHalfUrl, closed: sadClosedUrl },
  annoyed: { half: annoyedHalfUrl, closed: annoyedClosedUrl },
};

/** Resolve a slot to its half-blink / fully-closed frame URLs. */
export function blinkFrames(slot: ExpressionSlot): BlinkFrameUrls {
  return BLINK_FRAME_URLS[slot];
}
