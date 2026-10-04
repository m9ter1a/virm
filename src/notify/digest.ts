// Pure: the daily digest. What happened since the last one, what is still
// waiting for an answer, and whether the machinery is healthy.
import { GROUP_LABEL, GROUPS, type GroupId } from "../types.js";
import { ICON } from "./format.js";

export interface DigestData {
  since: number;
  now: number;
  counts: Record<GroupId, number>;
  byTracker: { name: string; counts: Record<GroupId, number> }[];
  /** Urgent posts nobody has replied to or skipped. */
  unanswered: { title: string; subreddit: string; threadUrl: string; inboxUrl: string; createdUtc: number }[];
  model: { calls: number; errors: number };
  feedsFailing: number;
}

export interface DigestMessage {
  subject: string;
  text: string;
  /** One line, for a desktop notification. */
  short: string;
}

const hours = (ms: number) => Math.round(ms / 3_600_000);

export function digestMessage(d: DigestData): DigestMessage {
  const total = GROUPS.reduce((s, g) => s + d.counts[g], 0);
  const groupLine = GROUPS.map((g) => `${ICON[g]} ${GROUP_LABEL[g]} ${d.counts[g]}`).join(" · ");
  const lines = [`virm: ${total} new posts in the last ${hours(d.now - d.since)} h`, groupLine, ""];
  if (d.unanswered.length) {
    lines.push(`Urgent and still unanswered (${d.unanswered.length}):`);
    for (const u of d.unanswered) lines.push(`- r/${u.subreddit}, ${hours(d.now - u.createdUtc)} h ago: ${u.title}`, `  ${u.threadUrl}`);
    lines.push("");
  }
  if (d.byTracker.length) {
    lines.push("By tracker:");
    for (const t of d.byTracker) lines.push(`- ${t.name}: ${GROUPS.map((g) => `${GROUP_LABEL[g]} ${t.counts[g]}`).join(", ")}`);
    lines.push("");
  }
  const health = [`${d.model.calls} model calls, ${d.model.errors} errors`];
  if (d.feedsFailing) health.push(`${d.feedsFailing} feed${d.feedsFailing === 1 ? "" : "s"} failing`);
  lines.push(`Health: ${health.join("; ")}.`);
  const unanswered = d.unanswered.length ? `${d.unanswered.length} urgent unanswered · ` : "";
  return {
    subject: `virm daily: ${unanswered}${d.counts.urgent} urgent, ${d.counts.worth} worth a look`,
    text: lines.join("\n"),
    short: `${unanswered}${groupLine}`,
  };
}

/** YYYY-MM-DD in local time. */
export const localDay = (t: Date) =>
  `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;

/** Today's key when the digest is due and not yet sent today, else null. */
export function digestDue(now: Date, at: string, lastSentDay: string | null): string | null {
  const [h, m] = at.split(":").map(Number);
  const today = localDay(now);
  if (lastSentDay === today) return null;
  return now.getHours() * 60 + now.getMinutes() >= h * 60 + m ? today : null;
}
