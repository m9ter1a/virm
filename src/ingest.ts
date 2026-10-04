// Fetched items → stored items and pending verdicts. Decisions are made by
// pure functions; this only applies them to the store.
import type { Tracker } from "./config.js";
import type { Store } from "./db.js";
import { matchedQuery } from "./match.js";
import { prefilter } from "./prefilter.js";
import type { FeedSpec } from "./trackers.js";
import type { Item } from "./types.js";

export interface IngestResult {
  /** Items stored for the first time. */
  newItems: number;
  /** Verdicts waiting for the decision model. */
  pending: number;
  /** Verdicts settled without the model (excluded subreddit, bot…). */
  prefiltered: number;
  /** Older link posts that got their link and went back to the model. */
  relinked: number;
}

export interface IngestOptions {
  /**
   * The feed's first successful fetch. Its items are history, not news: they
   * are stored as backfill and classified, but never notified about.
   */
  coldStart: boolean;
  ownUsername?: string;
  now: number;
}

export function ingest(
  store: Store,
  feed: FeedSpec,
  items: Item[],
  trackers: Map<string, Tracker>,
  o: IngestOptions,
): IngestResult {
  const r: IngestResult = { newItems: 0, pending: 0, prefiltered: 0, relinked: 0 };
  store.transaction(() => {
    for (const item of items) {
      const known = store.hasItem(item.id);
      if (known && item.link) r.relinked += store.fillLink(item.id, item.link);
      const toAdd: { tracker: string; phrase: string | null; noise?: string }[] = [];
      for (const name of feed.trackers) {
        const t = trackers.get(name);
        if (!t || t.paused || (known && store.hasVerdict(item.id, name))) continue;
        const phrase = t.queries.length ? matchedQuery(t, item) : null;
        // Search and subreddit feeds belong to their tracker; a comment feed is
        // shared, so a comment counts only if it matches one of the queries.
        if (feed.kind === "comments" && !phrase) continue;
        const pre = prefilter(item, t, o.ownUsername);
        if (pre.action === "skip") continue;
        toAdd.push({ tracker: name, phrase, noise: pre.action === "noise" ? pre.reason : undefined });
      }
      if (toAdd.length === 0) continue;
      if (!known) {
        store.insertItem(item, o.coldStart ? "backfill" : "new", o.now);
        r.newItems++;
      }
      for (const v of toAdd) {
        if (v.noise) {
          store.insertVerdict({ itemId: item.id, tracker: v.tracker, phrase: v.phrase, feed: feed.url, state: "prefiltered", grp: "noise", reason: v.noise, now: o.now });
          r.prefiltered++;
        } else {
          store.insertVerdict({ itemId: item.id, tracker: v.tracker, phrase: v.phrase, feed: feed.url, state: "pending", now: o.now });
          r.pending++;
        }
      }
      if (toAdd.some((v) => v.noise)) store.refreshItemGroup(item.id);
    }
  });
  return r;
}
