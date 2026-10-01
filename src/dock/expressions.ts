/**
 * Expression slot -> bundled image URL.
 *
 * The semantic mapping lives in `expressionSlots.ts` (pure, tested);
 * this module only binds each slot to its PNG. Every slot in
 * `SLOT_FILENAMES` must have a binding here — the asset test enforces
 * it.
 */

import annoyedUrl from "../../character/expressions/annoyed.png";
import curiousUrl from "../../character/expressions/curious.png";
import energeticUrl from "../../character/expressions/energetic.png";
import focusedUrl from "../../character/expressions/focused.png";
import happyUrl from "../../character/expressions/happy.png";
import hungryUrl from "../../character/expressions/hungry.png";
import playfulUrl from "../../character/expressions/playful.png";
import pointUrl from "../../character/expressions/point.png";
import restChinUrl from "../../character/expressions/rest_chin.png";
import sadUrl from "../../character/expressions/sad.png";
import sleepyUrl from "../../character/expressions/sleepy.png";
import stretchingUrl from "../../character/expressions/stretching.png";
import thirstyUrl from "../../character/expressions/thirsty.png";
import type { ExpressionSlot } from "./expressionSlots";

const EXPRESSION_URLS: Record<ExpressionSlot, string> = {
  greeting: curiousUrl,
  hungry: hungryUrl,
  thirsty: thirstyUrl,
  stretching: stretchingUrl,
  sleepy: sleepyUrl,
  energetic: energeticUrl,
  relaxed: restChinUrl,
  focused: focusedUrl,
  pointing: pointUrl,
  playful: playfulUrl,
  happy: happyUrl,
  sad: sadUrl,
  annoyed: annoyedUrl,
};

/** Resolve a slot to its bundled image URL. */
export function expressionUrl(slot: ExpressionSlot): string {
  return EXPRESSION_URLS[slot];
}
