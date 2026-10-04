// Pure: decisions that need no model. Deterministic rules run before the
// decision model ever sees an item.
import type { Tracker } from "./config.js";
import type { Item } from "./types.js";

export type Prefilter =
  | { action: "skip"; reason: string }
  | { action: "noise"; reason: string }
  | { action: "decide" };

/** Accounts whose posts are never worth a model call. */
const BOTS = new Set(["automoderator"]);

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function prefilter(item: Item, tracker: Tracker, ownUsername?: string): Prefilter {
  if (ownUsername && same(item.author, ownUsername)) return { action: "skip", reason: "own post" };
  if (tracker.excludeSubreddits.some((s) => same(s, item.subreddit)))
    return { action: "noise", reason: `excluded subreddit r/${item.subreddit}` };
  if (tracker.excludeAuthors.some((a) => same(a, item.author)))
    return { action: "noise", reason: `excluded author u/${item.author}` };
  if (BOTS.has(item.author.toLowerCase())) return { action: "noise", reason: `bot u/${item.author}` };
  return { action: "decide" };
}
