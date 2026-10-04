// Pure: who gets told about what, and when to try again.
import type { NOTIFY_GROUPS } from "../config.js";
import type { GroupId } from "../types.js";

/**
 * A post first seen longer ago than this is not news any more. It covers the
 * model catching up after an outage without paging about yesterday's posts.
 */
export const MAX_NOTIFY_DELAY_MS = 6 * 3_600_000;

export interface Candidate {
  group: GroupId | null;
  status: "new" | "backfill" | "replied" | "skipped";
  dupOf: string | null;
  firstSeen: number;
}

export interface ChannelPlan {
  groups: readonly (typeof NOTIFY_GROUPS)[number][];
  /** When this channel was first set up: nothing older is sent to it, so setting up Slack does not replay the past. */
  activeSince: number;
}

export function shouldNotify(c: Candidate, ch: ChannelPlan, now: number): boolean {
  if (c.status !== "new") return false; // backfill is history; replied and skipped are done
  if (c.dupOf !== null) return false; // a cross-post: the first copy was the news
  if (!c.group || c.group === "noise") return false; // Noise never notifies
  if (!(ch.groups as readonly string[]).includes(c.group)) return false;
  if (c.firstSeen < ch.activeSince) return false;
  return now - c.firstSeen <= MAX_NOTIFY_DELAY_MS;
}

const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];

/** After a failed send: when to try again, or null to give up. */
export function retryDelay(failures: number): number | null {
  return RETRY_DELAYS_MS[failures - 1] ?? null;
}
