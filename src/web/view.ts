// Pure: database rows → the JSON the inbox page renders.
import type { FeedState } from "../budget.js";
import type { Tracker } from "../config.js";
import type { ItemRow, VerdictRow } from "../db.js";
import type { StoredAnswers } from "../decide.js";
import { buildFeeds, type FeedKind } from "../trackers.js";
import type { Answers, GroupId } from "../types.js";
import { linkInfo, type LinkInfo } from "../links.js";

export interface VerdictView {
  tracker: string;
  template: string | null;
  phrase: string | null;
  state: VerdictRow["state"];
  group: GroupId | null;
  reason: string | null;
  error: string | null;
  decider: string | null;
  answers: Answers | null;
}

export interface ItemView {
  id: string;
  kind: "post" | "comment";
  subreddit: string;
  author: string;
  title: string;
  text: string;
  /** Only ever an https URL; anything else becomes "". */
  url: string;
  /** What the post links to when it is not a text post. Always http(s). */
  link: LinkInfo | null;
  createdUtc: number;
  firstSeen: number;
  group: GroupId | null;
  codeGroup: GroupId | null;
  userGroup: GroupId | null;
  status: ItemRow["status"];
  seen: boolean;
  /** The same post in other subreddits. */
  copies: { id: string; subreddit: string; url: string }[];
  verdicts: VerdictView[];
}

export const safeUrl = (u: string) => (/^https:\/\/([a-z0-9-]+\.)*reddit\.com\//i.test(u) ? u : "");

export function itemView(
  item: ItemRow,
  verdicts: VerdictRow[],
  trackers: Map<string, Tracker>,
  copies: { id: string; subreddit: string; url: string }[] = [],
): ItemView {
  return {
    id: item.id,
    kind: item.kind,
    subreddit: item.subreddit,
    author: item.author,
    title: item.title,
    text: item.text,
    url: safeUrl(item.url),
    link: item.link ? linkInfo(item.link) : null,
    createdUtc: item.createdUtc,
    firstSeen: item.firstSeen,
    group: item.group,
    codeGroup: item.grp,
    userGroup: item.userGrp,
    status: item.status,
    seen: item.seenAt !== null,
    copies: copies.map((c) => ({ ...c, url: safeUrl(c.url) })),
    verdicts: verdicts.map((v) => ({
      tracker: v.tracker,
      template: trackers.get(v.tracker)?.template ?? null,
      phrase: v.phrase,
      state: v.state,
      group: v.grp,
      reason: v.reason,
      error: v.error,
      decider: v.decider,
      answers: v.answersJson ? (JSON.parse(v.answersJson) as StoredAnswers).answers : null,
    })),
  };
}

export interface FeedView {
  url: string;
  kind: FeedKind;
  /** The search query or the subreddit. */
  what: string;
  trackers: string[];
  intervalS: number | null;
  lastFetch: number | null;
  lastStatus: number | null;
  lastCount: number | null;
  nextDue: number | null;
  failures: number;
  lastError: string | null;
}

/** Every feed the current trackers need, with what is known about it. */
export function feedViews(states: Map<string, FeedState>, trackers: Tracker[]): FeedView[] {
  return buildFeeds(trackers).map((spec) => {
    const s = states.get(spec.url);
    const u = new URL(spec.url);
    return {
      url: spec.url,
      kind: spec.kind,
      what: spec.kind === "search" ? (u.searchParams.get("q") ?? "") : `r/${u.pathname.split("/")[2]}`,
      trackers: spec.trackers,
      intervalS: s?.intervalS ?? null,
      lastFetch: s?.lastFetch ?? null,
      lastStatus: s?.lastStatus ?? null,
      lastCount: s?.lastCount ?? null,
      nextDue: s && s.everOk ? s.nextDue : null,
      failures: s?.failures ?? 0,
      lastError: s?.lastError ?? null,
    };
  });
}
