// Pure: what a notification says. Text from Reddit is untrusted here too: a
// title can carry "<!channel>" for Slack or "@everyone" for Discord, so each
// channel escapes it (and Discord is told to ping nobody).
import type { LinkInfo } from "../links.js";
import { GROUP_LABEL, type GroupId } from "../types.js";

export const ICON: Record<GroupId, string> = { urgent: "🔥", worth: "📌", fyi: "👀", noise: "🗑" };

export interface Notice {
  itemId: string;
  group: GroupId;
  tracker: string;
  phrase: string | null;
  kind: "post" | "comment";
  subreddit: string;
  author: string;
  title: string;
  createdUtc: number;
  threadUrl: string;
  inboxUrl: string;
  link: LinkInfo | null;
  /** P(the post's group), the strongest yes/no signals, P(on topic). */
  score: { group: number; onTopic: number; signals: [string, number][] };
  /** The same post in other subreddits. */
  copies: number;
}

export function ago(t: number, now: number): string {
  const m = Math.max(0, Math.round((now - t) / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

const truncate = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const oneLine = (s: string) => s.replace(/[\r\n\t]+/g, " ").trim();

/** 🔥 Urgent · r/node · 40 min ago · u/someone · freshclone · "fails on CI" */
export function headline(n: Notice, now: number): string {
  const parts = [`${ICON[n.group]} ${GROUP_LABEL[n.group]}`, `r/${n.subreddit}`, ago(n.createdUtc, now), `u/${n.author}`, n.tracker];
  if (n.phrase) parts.push(n.phrase);
  if (n.copies) parts.push(`+${n.copies} cross-post${n.copies === 1 ? "" : "s"}`);
  return oneLine(parts.join(" · "));
}

/** urgent 0.86 · asks help 0.97 · on topic 0.93 */
export function scoreLine(n: Notice): string {
  const parts = [`${n.group} ${n.score.group.toFixed(2)}`];
  for (const [name, p] of n.score.signals) parts.push(`${name.replace(/_/g, " ")} ${p.toFixed(2)}`);
  parts.push(`on topic ${n.score.onTopic.toFixed(2)}`);
  return parts.join(" · ");
}

export function title(n: Notice): string {
  return truncate(oneLine(n.kind === "comment" ? `Comment in: ${n.title}` : n.title) || "(no title)", 300);
}

/** The four lines of the brief, for email, the generic webhook and logs. */
export function plainText(n: Notice, now: number): string {
  return [headline(n, now), title(n), scoreLine(n), `Thread: ${n.threadUrl}   Inbox: ${n.inboxUrl}`].join("\n");
}

/** Slack mrkdwn treats &, < and > as control characters: "<!channel>" would ping everyone. */
export const escapeSlack = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Discord markdown; mentions are switched off separately with allowed_mentions. */
export const escapeDiscord = (s: string) => s.replace(/([\\*_~`|>#[\]()])/g, "\\$1");

/** The two signals with the highest probability, for the score line. */
export function topSignals(signals: Record<string, number>, n = 2): [string, number][] {
  return Object.entries(signals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}
