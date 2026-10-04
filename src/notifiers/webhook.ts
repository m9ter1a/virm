// Any URL, JSON POST: n8n, Zapier, a Telegram bot, your own code.
import { plainText, type Notice } from "../notify/format.js";
import { postJson, retryAfterHeader, type Notifier } from "./types.js";

export function createWebhookNotifier(url: string, doFetch: typeof fetch = fetch): Notifier {
  return {
    name: "webhook",
    minGapMs: 500,
    async send(n: Notice, now: number) {
      await postJson(
        doFetch,
        url,
        {
          type: "virm.post",
          version: 1,
          group: n.group,
          tracker: n.tracker,
          matched: n.phrase,
          post: {
            id: n.itemId,
            kind: n.kind,
            subreddit: n.subreddit,
            author: n.author,
            title: n.title,
            createdUtc: new Date(n.createdUtc).toISOString(),
            link: n.link?.url ?? null,
            crossPosts: n.copies,
          },
          score: { group: n.score.group, onTopic: n.score.onTopic, signals: Object.fromEntries(n.score.signals) },
          links: { thread: n.threadUrl, inbox: n.inboxUrl },
          text: plainText(n, now),
        },
        retryAfterHeader,
      );
    },
    async sendDigest(d) {
      await postJson(doFetch, url, { type: "virm.digest", version: 1, subject: d.subject, text: d.text }, retryAfterHeader);
    },
  };
}
