// Pending verdicts → the decision model → route → stored group.
import type { Thresholds, Tracker } from "./config.js";
import type { Store } from "./db.js";
import { DeciderBlockedError, type Decider } from "./deciders/types.js";
import { buildQuestions, buildState, toAnswers } from "./questions.js";
import { route } from "./route.js";
import type { Answers } from "./types.js";

/** One set for every tracker, or each tracker's own. */
export type ThresholdsFor = Thresholds | ((tracker: string) => Thresholds);
const perTracker = (t: ThresholdsFor) => (typeof t === "function" ? t : () => t);

/** After this many failed calls an item is marked as an error and left alone. */
export const MAX_ATTEMPTS = 5;

/** What is kept in verdicts.answers_json: everything the model said, plus what the router read. */
export interface StoredAnswers {
  model: string;
  answers: Answers;
  raw: unknown;
  usage?: { input_tokens: number; output_tokens: number };
}

export interface BatchResult {
  decided: number;
  failed: number;
  /** Set when the decider cannot work until the user acts (bad key, billing). */
  blocked?: string;
}

export async function decideBatch(
  store: Store,
  decider: Decider,
  trackers: Map<string, Tracker>,
  thresholds: ThresholdsFor,
  o: { limit: number; now: () => number; onDecided?: (line: string) => void },
): Promise<BatchResult> {
  const r: BatchResult = { decided: 0, failed: 0 };
  const thresholdsOf = perTracker(thresholds);
  for (const v of store.pendingVerdicts(o.limit, [...trackers.keys()])) {
    const t = trackers.get(v.tracker)!;
    try {
      const res = await decider.decide(buildState(v.item, v.phrase), buildQuestions(t));
      const answers = toAnswers(res.answers, t);
      const ageHours = (o.now() - v.item.createdUtc) / 3_600_000;
      const routed = route(answers, ageHours, t.urgentHours, thresholdsOf(v.tracker));
      const stored: StoredAnswers = { model: res.model, answers, raw: res.answers, usage: res.usage };
      store.saveDecision(v.itemId, v.tracker, {
        decider: decider.id,
        answersJson: JSON.stringify(stored),
        grp: routed.group,
        reason: routed.reason,
        now: o.now(),
      });
      store.incr("model_calls");
      store.incr("model_input_tokens", res.usage?.input_tokens ?? 0);
      r.decided++;
      o.onDecided?.(`${routed.group.padEnd(6)} ${v.tracker} · r/${v.item.subreddit} · ${v.item.title.slice(0, 70)}`);
    } catch (err) {
      store.incr("model_errors");
      if (err instanceof DeciderBlockedError) {
        r.blocked = err.message;
        return r;
      }
      store.saveFailure(v.itemId, v.tracker, (err as Error).message, v.attempts + 1 >= MAX_ATTEMPTS);
      r.failed++;
    }
  }
  return r;
}

/** Thresholds changed: recompute every group from stored probabilities, no model calls. */
export function rerouteAll(
  store: Store,
  trackers: Map<string, Tracker>,
  thresholds: ThresholdsFor,
  now: number,
  only?: string,
): { changed: number; total: number } {
  const thresholdsOf = perTracker(thresholds);
  let changed = 0;
  let total = 0;
  const items = new Set<string>();
  store.transaction(() => {
    for (const v of store.decidedVerdicts()) {
      const t = trackers.get(v.tracker);
      if (!t || !v.answersJson || (only !== undefined && v.tracker !== only)) continue;
      const stored = JSON.parse(v.answersJson) as StoredAnswers;
      const routed = route(stored.answers, (now - v.item.createdUtc) / 3_600_000, t.urgentHours, thresholdsOf(v.tracker));
      total++;
      if (routed.group !== v.grp) {
        store.setVerdictGroup(v.itemId, v.tracker, routed.group, routed.reason);
        items.add(v.itemId);
        changed++;
      }
    }
    for (const id of items) store.refreshItemGroup(id);
  });
  return { changed, total };
}
