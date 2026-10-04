// Pure: which thresholds apply to a tracker, and how its Urgent threshold
// follows the user's own labels.
//
// Precedence: set by hand in trackers.json > learned from labels > config.json.
// Only Urgent is learned, because it is the one that interrupts a person.
import type { Thresholds, Tracker } from "./config.js";
import type { GroupId } from "./types.js";

export type ThresholdSource = "default" | "learned" | "manual";

export interface LearnedThreshold {
  urgent: number;
  /** Labels it was learned from. */
  n: number;
  updatedAt: number;
}

export interface Effective extends Thresholds {
  urgentSource: ThresholdSource;
  learnedFrom: number | null;
}

export function effectiveThresholds(global: Thresholds, tracker: Pick<Tracker, "thresholds"> | undefined, learned?: LearnedThreshold): Effective {
  const manual = tracker?.thresholds ?? {};
  const urgentSource: ThresholdSource = manual.urgent !== undefined ? "manual" : learned ? "learned" : "default";
  return {
    urgent: manual.urgent ?? learned?.urgent ?? global.urgent,
    spam: manual.spam ?? global.spam,
    offTopic: manual.offTopic ?? global.offTopic,
    urgentOnTopic: manual.urgentOnTopic ?? global.urgentOnTopic,
    urgentSource,
    learnedFrom: urgentSource === "learned" ? learned!.n : null,
  };
}

/** One labelled post: what d1 said, and where the user put it. */
export interface Sample {
  pUrgent: number;
  onTopic: number;
  spam: number;
  label: GroupId;
}

export interface LearnOptions {
  /** Labels needed before anything is learned. A handful would make the threshold jump. */
  minSamples: number;
  /** Labelled Urgent and labelled not-Urgent each need at least this many. */
  minEach: number;
  /** Largest move per update, so a few stray clicks cannot swing it. */
  maxStep: number;
  /** Bounds. People label what they see, mostly the top groups, so the data
   * over-reports false alarms; without a ceiling the threshold would creep up
   * until nothing is Urgent. */
  min: number;
  max: number;
  /** A needless alert costs this many missed ones: "when in doubt, demote". */
  falseAlarmCost: number;
  grid: number;
}

export const LEARN: LearnOptions = { minSamples: 20, minEach: 3, maxStep: 0.1, min: 0.5, max: 0.95, falseAlarmCost: 3, grid: 0.05 };

export interface LearnResult {
  /** The threshold to use now: one bounded step from current toward the best. */
  urgent: number;
  /** The best threshold on these labels. */
  best: number;
  n: number;
  falseAlarms: number;
  missed: number;
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/**
 * Labels are judged on content, as if each post had just appeared, so age is
 * left out here; the other gates are the ones the router applies.
 */
export function learnUrgent(samples: Sample[], current: number, gates: Thresholds, o: LearnOptions = LEARN): LearnResult | null {
  const positives = samples.filter((s) => s.label === "urgent").length;
  if (samples.length < o.minSamples || positives < o.minEach || samples.length - positives < o.minEach) return null;

  const urgentAt = (s: Sample, t: number) =>
    s.spam < gates.spam && s.onTopic > gates.offTopic && s.onTopic >= gates.urgentOnTopic && s.pUrgent >= t;

  const scored: { t: number; cost: number; falseAlarms: number; missed: number }[] = [];
  for (let i = 0; o.min + i * o.grid <= o.max + 1e-9; i++) {
    const t = round2(o.min + i * o.grid);
    let falseAlarms = 0;
    let missed = 0;
    for (const s of samples) {
      const u = urgentAt(s, t);
      if (u && s.label !== "urgent") falseAlarms++;
      if (!u && s.label === "urgent") missed++;
    }
    scored.push({ t, cost: o.falseAlarmCost * falseAlarms + missed, falseAlarms, missed });
  }
  // Often a whole range of thresholds is equally good on the labels. Its edges
  // sit right against a labelled post, so take the middle: the widest margin
  // on both sides. Between two equally central ones, the higher.
  const minCost = Math.min(...scored.map((s) => s.cost));
  const tied = scored.filter((s) => s.cost === minCost);
  const middle = (tied[0].t + tied[tied.length - 1].t) / 2;
  const best = tied.reduce((a, b) => (Math.abs(b.t - middle) <= Math.abs(a.t - middle) + 1e-9 ? b : a));
  const urgent = round2(clamp(current + clamp(best.t - current, -o.maxStep, o.maxStep), o.min, o.max));
  return { urgent, best: best.t, n: samples.length, falseAlarms: best.falseAlarms, missed: best.missed };
}
