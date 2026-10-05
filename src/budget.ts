// Pure: Reddit's RSS allows one request per calendar minute per IP. This
// decides when the next request goes out and which feed it is for. Each feed
// has its own interval, which adapts to how busy the feed turns out to be.
import type { FeedKind } from "./trackers.js";

export const MINUTE = 60_000;
/** Fire this long after the minute boundary, so clock skew cannot land two requests in one minute. */
export const SLOT_OFFSET_MS = 1_500;

export interface Bounds {
  /** How stale a feed may get: the normal polling interval. */
  target: number;
  /** Never poll more often than this, however busy the feed. */
  min: number;
}

/** Seconds. A full page of 100 comments covered ~5 days in r/node, so comments can wait longer. */
export const INTERVALS: Record<FeedKind, Bounds> = {
  search: { target: 5 * 60, min: 2 * 60 },
  subreddit: { target: 10 * 60, min: 5 * 60 },
  comments: { target: 30 * 60, min: 10 * 60 },
};

const PRIORITY: Record<FeedKind, number> = { search: 0, subreddit: 1, comments: 2 };

export interface FeedState {
  url: string;
  kind: FeedKind;
  intervalS: number;
  nextDue: number;
  lastFetch: number | null;
  lastStatus: number | null;
  lastCount: number | null;
  lastFresh: number | null;
  failures: number;
  everOk: boolean;
  lastError: string | null;
}

/**
 * A feed that was never polled is the most overdue of all. Giving it "due
 * now" instead lets feeds that are already overdue win every slot, and on a
 * busy budget it would never be polled.
 */
export function newFeedState(url: string, kind: FeedKind): FeedState {
  return {
    url,
    kind,
    intervalS: INTERVALS[kind].target,
    nextDue: 0,
    lastFetch: null,
    lastStatus: null,
    lastCount: null,
    lastFresh: null,
    failures: 0,
    everOk: false,
    lastError: null,
  };
}

/** The next moment a request may go out: just after the next minute boundary. */
export function nextSlot(now: number): number {
  return Math.floor(now / MINUTE) * MINUTE + MINUTE + SLOT_OFFSET_MS;
}

/**
 * When a feed is due again. Counted from the start of the minute, not from the
 * answer: that arrives a second or two after the slot, so counted from it, a
 * 5 minute interval just missed the slot 5 minutes later and became 6.
 */
function dueAfter(now: number, seconds: number): number {
  return Math.floor(now / MINUTE) * MINUTE + seconds * 1000;
}

/** The most overdue feed, or undefined if none is due. Ties go to search, which is the most time-sensitive. */
export function pickNext(states: FeedState[], now: number): FeedState | undefined {
  return states
    .filter((s) => s.nextDue <= now)
    .sort((a, b) => a.nextDue - b.nextDue || PRIORITY[a.kind] - PRIORITY[b.kind])[0];
}

export interface FetchOutcome {
  /** Items in the response. */
  count: number;
  /** The page size requested. */
  limit: number;
  /** Creation time of the oldest item in the response. */
  oldestCreated: number | null;
  /** New verdicts this fetch produced. Informational. */
  fresh: number;
}

/**
 * A full page reaches back only so far. If 100 items cover three hours, a
 * feed polled every five hours loses posts, so the interval is at most half
 * the time a full page covers. A page that is not full covers everything.
 */
export function afterSuccess(s: FeedState, o: FetchOutcome, now: number): FeedState {
  const b = INTERVALS[s.kind];
  const full = o.count >= o.limit * 0.9 && o.oldestCreated !== null;
  const coverageS = full ? (now - o.oldestCreated!) / 1000 : Infinity;
  const interval = Math.round(Math.max(b.min, Math.min(b.target, coverageS / 2)));
  return {
    ...s,
    intervalS: interval,
    nextDue: dueAfter(now, interval),
    lastFetch: now,
    lastStatus: 200,
    lastCount: o.count,
    lastFresh: o.fresh,
    failures: 0,
    everOk: true,
    lastError: o.count === 0 && s.kind === "search" ? "empty search feed: check the query (over 512 chars returns nothing)" : null,
  };
}

/** 429: someone else on this IP used the minute; retry soon. Anything else: back off exponentially up to an hour. */
export function afterFailure(s: FeedState, status: number | null, error: string, now: number): FeedState {
  const failures = s.failures + 1;
  const waitS = status === 429 ? 2 * 60 : Math.min(60 * 60, 5 * 60 * 2 ** (failures - 1));
  return { ...s, nextDue: dueAfter(now, waitS), lastFetch: now, lastStatus: status, failures, lastError: error };
}
