// Discord webhook. Mentions are switched off for every message: a Reddit title
// saying "@everyone" must not ping a server.
import { escapeDiscord, headline, scoreLine, title, type Notice } from "../notify/format.js";
import { postJson, type Notifier } from "./types.js";

const COLOR = { urgent: 0xe03131, worth: 0x1c7ed6, fyi: 0x0c8599, noise: 0x7d8792 };
const NO_MENTIONS = { parse: [] as string[] };

/** Discord says how long to wait in the JSON body, in seconds. */
function retryAfter(_res: Response, text: string): number {
  try {
    const s = Number(JSON.parse(text).retry_after);
    if (Number.isFinite(s) && s > 0) return Math.ceil(s * 1000);
  } catch {}
  return 5_000;
}

export function createDiscordNotifier(webhookUrl: string, doFetch: typeof fetch = fetch): Notifier {
  return {
    name: "discord",
    minGapMs: 1_100,
    async send(n: Notice, now: number) {
      const embed = {
        title: title(n).slice(0, 256),
        url: n.threadUrl || undefined,
        color: COLOR[n.group],
        description: [escapeDiscord(headline(n, now)), escapeDiscord(scoreLine(n)), `[Open in the virm inbox](${n.inboxUrl})`].join("\n"),
      };
      await postJson(doFetch, webhookUrl, { username: "virm", allowed_mentions: NO_MENTIONS, embeds: [embed] }, retryAfter);
    },
    async sendDigest(d) {
      const content = `**${escapeDiscord(d.subject)}**\n${escapeDiscord(d.text)}`.slice(0, 2000);
      await postJson(doFetch, webhookUrl, { username: "virm", allowed_mentions: NO_MENTIONS, content }, retryAfter);
    },
  };
}
