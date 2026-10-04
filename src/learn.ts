// After the user puts a post in a group: re-learn the Urgent threshold of the
// trackers that found it, and re-route their posts if it moved. The learning
// itself is the pure learnUrgent; this only reads and writes the store.
import type { Store } from "./db.js";
import { rerouteAll, type StoredAnswers } from "./decide.js";
import type { Live } from "./main.js";
import { learnUrgent, type Sample } from "./thresholds.js";

export interface ThresholdChange {
  tracker: string;
  from: number;
  to: number;
  /** Labels it was learned from. */
  n: number;
  /** Posts that changed group because of it. */
  moved: number;
}

export function relearn(store: Store, live: Live, trackers: string[], now: number): ThresholdChange[] {
  if (!live.settings.learnThresholds) return [];
  const changes: ThresholdChange[] = [];
  for (const name of new Set(trackers)) {
    const tracker = live.trackers.get(name);
    if (!tracker || tracker.thresholds.urgent !== undefined) continue; // set by hand: never learned over
    const current = live.effective(name);
    const samples: Sample[] = store.labeledSamples(name).map(({ answersJson, label }) => {
      const a = (JSON.parse(answersJson) as StoredAnswers).answers;
      return { pUrgent: a.group.probabilities.urgent, onTopic: a.onTopic, spam: a.spam, label };
    });
    const learned = learnUrgent(samples, current.urgent, current);
    if (!learned) continue;
    const record = { urgent: learned.urgent, n: learned.n, updatedAt: now };
    store.setLearned(name, record);
    live.learned.set(name, record);
    if (learned.urgent === current.urgent) continue;
    const { changed } = rerouteAll(store, live.trackers, live.thresholdsFor, now, name);
    changes.push({ tracker: name, from: current.urgent, to: learned.urgent, n: learned.n, moved: changed });
  }
  return changes;
}
