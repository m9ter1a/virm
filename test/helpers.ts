import { resolveTracker, TrackerSchema, type Tracker, type TrackerInput } from "../src/config.js";
import type { Answers, Item } from "../src/types.js";

export function tracker(over: Partial<TrackerInput> = {}): Tracker {
  return resolveTracker(
    TrackerSchema.parse({
      name: "freshclone",
      about: "I maintain freshclone, a CLI that checks whether a repo builds on a clean machine.",
      queries: ['"works on my machine"', "lockfile"],
      ...over,
    }),
  );
}

export const HOUR = 3_600_000;

export function item(over: Partial<Item> = {}): Item {
  return {
    id: "t3_abc",
    kind: "post",
    subreddit: "node",
    author: "someone",
    title: "Build passes locally but fails on CI",
    text: "It works on my machine, but GitHub Actions says the lockfile is out of date.",
    url: "https://www.reddit.com/r/node/comments/abc/x/",
    link: null,
    createdUtc: Date.UTC(2026, 9, 3, 12),
    ...over,
  };
}

export function answers(over: Partial<Answers> & { probs?: Partial<Answers["group"]["probabilities"]> } = {}): Answers {
  const probabilities = { urgent: 0.1, worth: 0.6, fyi: 0.2, noise: 0.1, ...over.probs };
  const choice = (Object.keys(probabilities) as (keyof typeof probabilities)[]).reduce((a, b) =>
    probabilities[b] > probabilities[a] ? b : a,
  );
  return {
    group: { choice, confidence: probabilities[choice], probabilities },
    onTopic: 0.9,
    spam: 0.05,
    signals: {},
    ...over,
  };
}
