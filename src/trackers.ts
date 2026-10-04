// Pure: trackers → the RSS feeds to poll.
//
// Search feeds are per tracker, not shared: Reddit search matches more loosely
// than any local re-check (a post whose only text is in an image still comes
// back), so the feed it came from is the only reliable way to know which
// tracker a post belongs to. The budget is not the constraint it looks like:
// one request returns 100 items, which covers hours even for a busy topic.
import { MAX_QUERY_LENGTH, type Tracker } from "./config.js";

export type FeedKind = "search" | "subreddit" | "comments";

export interface FeedSpec {
  url: string;
  kind: FeedKind;
  /** Names of the trackers this feed serves. */
  trackers: string[];
}

const BASE = "https://www.reddit.com";

/** A query with several terms is grouped, so OR does not bind to its last term only. */
function asOrOperand(q: string): string {
  const tokens = q.match(/"[^"]*"|\S+/g) ?? [];
  return tokens.length > 1 ? `(${q})` : q;
}

/** Packs queries into as few OR expressions as fit Reddit's length limit. */
export function packQueries(queries: string[], max = MAX_QUERY_LENGTH): string[] {
  const packs: string[] = [];
  let current = "";
  for (const q of queries) {
    const operand = queries.length > 1 ? asOrOperand(q) : q;
    const joined = current ? `${current} OR ${operand}` : operand;
    if (joined.length <= max) {
      current = joined;
    } else {
      if (current) packs.push(current);
      current = operand.length <= max ? operand : q;
    }
  }
  if (current) packs.push(current);
  return packs;
}

export const searchUrl = (q: string) =>
  `${BASE}/search.rss?q=${encodeURIComponent(q)}&sort=new&limit=100&type=link`;
export const subredditUrl = (sub: string) => `${BASE}/r/${sub.toLowerCase()}/new/.rss?limit=100`;
export const commentsUrl = (sub: string) => `${BASE}/r/${sub.toLowerCase()}/comments/.rss?limit=100`;

export function buildFeeds(trackers: Tracker[]): FeedSpec[] {
  const feeds = new Map<string, FeedSpec>();
  const add = (url: string, kind: FeedKind, tracker: string) => {
    const f = feeds.get(url) ?? { url, kind, trackers: [] };
    if (!f.trackers.includes(tracker)) f.trackers.push(tracker);
    feeds.set(url, f);
  };
  for (const t of trackers) {
    if (t.paused) continue;
    for (const q of packQueries(t.queries)) add(searchUrl(q), "search", t.name);
    for (const s of t.subreddits) add(subredditUrl(s), "subreddit", t.name);
    for (const s of t.commentSubreddits) add(commentsUrl(s), "comments", t.name);
  }
  return [...feeds.values()];
}
