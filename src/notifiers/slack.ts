// Slack incoming webhook. One URL per channel; a separate webhook per group
// means a separate Slack channel, with its own sound settings.
import { escapeSlack, headline, scoreLine, title, type Notice } from "../notify/format.js";
import { postJson, retryAfterHeader, type Notifier } from "./types.js";

export function createSlackNotifier(webhookUrl: string, doFetch: typeof fetch = fetch): Notifier {
  return {
    name: "slack",
    minGapMs: 1_100, // Slack allows about one message per second per webhook
    async send(n: Notice, now: number) {
      const text = [
        `*${escapeSlack(headline(n, now))}*`,
        n.threadUrl ? `<${n.threadUrl}|${escapeSlack(title(n))}>` : escapeSlack(title(n)),
        `_${escapeSlack(scoreLine(n))}_`,
        `<${n.inboxUrl}|Open in the virm inbox>`,
      ].join("\n");
      await postJson(doFetch, webhookUrl, { text, unfurl_links: false, unfurl_media: false }, retryAfterHeader);
    },
    async sendDigest(d) {
      await postJson(doFetch, webhookUrl, { text: `*${escapeSlack(d.subject)}*\n${escapeSlack(d.text)}`, unfurl_links: false }, retryAfterHeader);
    },
  };
}
