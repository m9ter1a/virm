// Notifications: who is told what, how it is worded and escaped, rate limits,
// retries, and the daily digest. No real channel is ever contacted.
import { describe, expect, it } from "vitest";
import { SettingsSchema } from "../src/config.js";
import { Store } from "../src/db.js";
import { decideBatch } from "../src/decide.js";
import type { Decider } from "../src/deciders/types.js";
import { ingest } from "../src/ingest.js";
import { Live, type Runtime } from "../src/main.js";
import { buildNotifiers } from "../src/notify/channels.js";
import { digestDue, digestMessage } from "../src/notify/digest.js";
import { MAX_NOTIFY_DELAY_MS, retryDelay, shouldNotify } from "../src/notify/dispatch.js";
import { escapeDiscord, escapeSlack, headline, plainText, scoreLine, type Notice } from "../src/notify/format.js";
import { NotifyRunner } from "../src/notify/runner.js";
import { createDesktopNotifier } from "../src/notifiers/desktop.js";
import { createDiscordNotifier } from "../src/notifiers/discord.js";
import { createSlackNotifier } from "../src/notifiers/slack.js";
import { RetryLater, type Notifier } from "../src/notifiers/types.js";
import { createWebhookNotifier } from "../src/notifiers/webhook.js";
import { buildFeeds } from "../src/trackers.js";
import { HOUR, item, tracker } from "./helpers.js";

const NOW = Date.UTC(2026, 9, 4, 12);

const notice = (over: Partial<Notice> = {}): Notice => ({
  itemId: "t3_abc",
  group: "urgent",
  tracker: "freshclone",
  phrase: '"fails on CI"',
  kind: "post",
  subreddit: "node",
  author: "someone",
  title: "Build passes locally but fails on GitHub Actions",
  createdUtc: NOW - 40 * 60_000,
  threadUrl: "https://www.reddit.com/r/node/comments/abc/x/",
  inboxUrl: "http://127.0.0.1:4545/i/t3_abc",
  link: null,
  score: { group: 0.86, onTopic: 0.93, signals: [["asks_help", 0.97]] },
  copies: 0,
  ...over,
});

describe("format", () => {
  it("writes the four lines of the brief", () => {
    expect(headline(notice(), NOW)).toBe('🔥 Urgent · r/node · 40 min ago · u/someone · freshclone · "fails on CI"');
    expect(scoreLine(notice())).toBe("urgent 0.86 · asks help 0.97 · on topic 0.93");
    expect(plainText(notice(), NOW).split("\n")).toHaveLength(4);
    expect(headline(notice({ copies: 3 }), NOW)).toMatch(/\+3 cross-posts$/);
  });

  it("defuses what Slack and Discord would treat as commands or mentions", () => {
    expect(escapeSlack("<!channel> urgent & <https://evil|click>")).toBe("&lt;!channel&gt; urgent &amp; &lt;https://evil|click&gt;");
    expect(escapeDiscord("**bold** [x](https://evil) _i_")).toBe("\\*\\*bold\\*\\* \\[x\\]\\(https://evil\\) \\_i\\_");
  });
});

describe("dispatch", () => {
  const ch = { groups: ["urgent"] as const, activeSince: NOW - 10 * HOUR };
  const c = (over = {}) => ({ group: "urgent" as const, status: "new" as const, dupOf: null, firstSeen: NOW - HOUR, ...over });

  it("tells about a fresh post in a subscribed group", () => {
    expect(shouldNotify(c(), ch, NOW)).toBe(true);
  });

  it("never tells about history, finished posts, copies or Noise", () => {
    expect(shouldNotify(c({ status: "backfill" }), ch, NOW)).toBe(false);
    expect(shouldNotify(c({ status: "replied" }), ch, NOW)).toBe(false);
    expect(shouldNotify(c({ dupOf: "t3_first" }), ch, NOW)).toBe(false);
    expect(shouldNotify(c({ group: "noise" }), { ...ch, groups: ["urgent", "worth", "fyi", "noise"] as never }, NOW)).toBe(false);
    expect(shouldNotify(c({ group: "worth" }), ch, NOW)).toBe(false);
  });

  it("does not replay the past to a channel set up just now, nor page about old posts", () => {
    expect(shouldNotify(c({ firstSeen: NOW - HOUR }), { ...ch, activeSince: NOW - 30 * 60_000 }, NOW)).toBe(false);
    expect(shouldNotify(c({ firstSeen: NOW - MAX_NOTIFY_DELAY_MS - 1 }), ch, NOW)).toBe(false);
  });

  it("retries a failed send three times, then gives up", () => {
    expect([1, 2, 3, 4].map(retryDelay)).toEqual([60_000, 300_000, 900_000, null]);
  });
});

describe("digest", () => {
  it("is due once a day, after its time", () => {
    const at = (h: number, m: number) => new Date(2026, 9, 4, h, m);
    expect(digestDue(at(8, 59), "09:00", "2026-10-03")).toBeNull();
    expect(digestDue(at(9, 0), "09:00", "2026-10-03")).toBe("2026-10-04");
    expect(digestDue(at(23, 0), "09:00", "2026-10-04")).toBeNull();
  });

  it("leads with what is still unanswered", () => {
    const m = digestMessage({
      since: NOW - 24 * HOUR,
      now: NOW,
      counts: { urgent: 2, worth: 7, fyi: 12, noise: 80 },
      byTracker: [{ name: "freshclone", counts: { urgent: 2, worth: 7, fyi: 12, noise: 80 } }],
      unanswered: [{ title: "CI broke", subreddit: "node", threadUrl: "https://www.reddit.com/r/node/x/", inboxUrl: "http://127.0.0.1:4545/i/t3_x", createdUtc: NOW - 5 * HOUR }],
      model: { calls: 101, errors: 0 },
      feedsFailing: 1,
    });
    expect(m.subject).toBe("virm daily: 1 urgent unanswered · 2 urgent, 7 worth a look");
    expect(m.text).toContain("101 new posts in the last 24 h");
    expect(m.text).toContain("r/node, 5 h ago: CI broke");
    expect(m.text).toContain("1 feed failing");
  });
});

/** A fetch that records what was sent and answers with the given responses in turn. */
function recorder(...responses: Response[]) {
  const calls: { url: string; body: any }[] = [];
  const doFetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) });
    return responses.shift() ?? new Response("ok");
  }) as typeof fetch;
  return { calls, doFetch };
}

describe("channels", () => {
  it("Slack: escapes Reddit text, links the thread, and turns 429 into a wait", async () => {
    const r = recorder(new Response("ok"), new Response("slow down", { status: 429, headers: { "retry-after": "7" } }));
    const slack = createSlackNotifier("https://hooks.slack.com/services/x", r.doFetch);
    await slack.send(notice({ title: "<!channel> CI is down" }), NOW);
    expect(r.calls[0].body.text).toContain("<https://www.reddit.com/r/node/comments/abc/x/|&lt;!channel&gt; CI is down>");
    expect(r.calls[0].body.text).not.toContain("<!channel>");
    await expect(slack.send(notice(), NOW)).rejects.toMatchObject({ afterMs: 7000 });
  });

  it("Discord: pings nobody, whatever the title says, and honours retry_after", async () => {
    const r = recorder(new Response(null, { status: 204 }), new Response(JSON.stringify({ retry_after: 1.5 }), { status: 429 }));
    const discord = createDiscordNotifier("https://discord.com/api/webhooks/x", r.doFetch);
    await discord.send(notice({ title: "@everyone CI is down" }), NOW);
    expect(r.calls[0].body.allowed_mentions).toEqual({ parse: [] });
    expect(r.calls[0].body.embeds[0]).toMatchObject({ title: "@everyone CI is down", url: "https://www.reddit.com/r/node/comments/abc/x/" });
    const err = await discord.send(notice(), NOW).catch((e) => e);
    expect(err).toBeInstanceOf(RetryLater);
    expect(err.afterMs).toBe(1500);
  });

  it("webhook: a stable JSON shape for n8n, Zapier or your own code", async () => {
    const r = recorder();
    await createWebhookNotifier("https://example.com/hook", r.doFetch).send(notice(), NOW);
    expect(r.calls[0].body).toMatchObject({
      type: "virm.post",
      version: 1,
      group: "urgent",
      tracker: "freshclone",
      post: { id: "t3_abc", subreddit: "node" },
      score: { group: 0.86, onTopic: 0.93, signals: { asks_help: 0.97 } },
      links: { thread: "https://www.reddit.com/r/node/comments/abc/x/", inbox: "http://127.0.0.1:4545/i/t3_abc" },
    });
  });

  it("desktop: a click opens the thread", async () => {
    const opened: string[] = [];
    const shown: Record<string, unknown>[] = [];
    const desktop = createDesktopNotifier((options, cb) => {
      shown.push(options);
      cb(null, "activate");
    }, (url) => opened.push(url));
    await desktop.send(notice(), NOW);
    expect(shown[0]).toMatchObject({ title: "🔥 Urgent · r/node · freshclone", message: "Build passes locally but fails on GitHub Actions" });
    expect(opened).toEqual(["https://www.reddit.com/r/node/comments/abc/x/"]);
  });

  it("a channel is on only when enabled and its secret is set", () => {
    const settings = SettingsSchema.parse({ notify: { desktop: { enabled: false } } });
    const off = buildNotifiers(settings, {});
    expect(off.notifiers).toHaveLength(0);
    expect(off.status.find((s) => s.name === "slack")).toMatchObject({ on: false, why: "set SLACK_WEBHOOK_URL in .env" });
    expect(off.status.find((s) => s.name === "email")).toMatchObject({ why: "set SMTP_URL and EMAIL_TO in .env" });
    expect(buildNotifiers(settings, { SLACK_WEBHOOK_URL: "http://hooks.slack.com/x" }).status.find((s) => s.name === "slack")?.why).toMatch(/https/);
    expect(buildNotifiers(settings, { DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/x" }).notifiers.map((n) => n.name)).toEqual(["discord"]);
  });
});

describe("runner", () => {
  const settings = SettingsSchema.parse({});
  const fakeDecider: Decider = {
    id: "fake",
    async decide(state) {
      const urgent = String(state.title).startsWith("U");
      const probs = urgent ? { urgent: 0.9, worth: 0.05, fyi: 0.03, noise: 0.02 } : { urgent: 0.01, worth: 0.01, fyi: 0.01, noise: 0.97 };
      return {
        model: "fake",
        answers: {
          group: { type: "choice", choice: urgent ? "urgent" : "noise", confidence: 0.9, probabilities: probs },
          on_topic: { type: "noul", noul: 0.95 },
          spam: { type: "noul", noul: 0.01 },
          asks_help: { type: "noul", noul: 0.9 },
          has_problem: { type: "noul", noul: 0.4 },
        },
      };
    },
  };

  /** A store with posts already decided, and a runner with a recording notifier. */
  async function setup(posts: Parameters<typeof item>[0][], o: { coldStart?: boolean; fail?: (n: number) => Error | null } = {}) {
    const t = tracker();
    const store = new Store(":memory:");
    const trackers = new Map([[t.name, t]]);
    let clock = NOW;
    const now = () => clock;
    // The channel was set up before these posts arrived.
    store.set("notify:since:slack", String(NOW - 2 * HOUR));
    ingest(store, buildFeeds([t]).find((f) => f.kind === "search")!, posts.map((p) => item(p)), trackers, { coldStart: o.coldStart ?? false, now: NOW - HOUR });
    await decideBatch(store, fakeDecider, trackers, settings.thresholds, { limit: 50, now });
    const sent: Notice[] = [];
    let calls = 0;
    const slack: Notifier = {
      name: "slack",
      minGapMs: 0,
      async send(n) {
        calls++;
        const e = o.fail?.(calls);
        if (e) throw e;
        sent.push(n);
      },
      async sendDigest() {},
    };
    const rt = { paths: { trackers: "missing.json" }, settings, trackers: [t], store, decider: null } as unknown as Runtime;
    const logs: string[] = [];
    const runner = new NotifyRunner({ store, live: new Live(rt), notifiers: [slack], inboxUrl: "http://127.0.0.1:4545", log: (s) => logs.push(s), now, pause: async () => {} });
    return { store, runner, sent, logs, advance: (ms: number) => (clock += ms) };
  }

  it("tells once about each fresh Urgent post, and never about Noise", async () => {
    const { runner, sent } = await setup([
      { id: "t3_u1", title: "U: CI broke after lockfile change", createdUtc: NOW - HOUR },
      { id: "t3_n1", title: "N: unrelated meme", createdUtc: NOW - HOUR },
    ]);
    await runner.tick();
    await runner.tick();
    expect(sent.map((n) => n.itemId)).toEqual(["t3_u1"]);
    expect(sent[0]).toMatchObject({ group: "urgent", tracker: "freshclone", inboxUrl: "http://127.0.0.1:4545/i/t3_u1" });
  });

  it("sends nothing on a cold start", async () => {
    const { runner, sent } = await setup([{ id: "t3_u1", title: "U: CI broke after lockfile change", createdUtc: NOW - HOUR }], { coldStart: true });
    await runner.tick();
    expect(sent).toEqual([]);
  });

  it("retries a failed send later, and gives up after three failures", async () => {
    const { runner, sent, store, advance } = await setup([{ id: "t3_u1", title: "U: CI broke", createdUtc: NOW - HOUR }], { fail: () => new Error("boom") });
    await runner.tick();
    expect(store.notification("t3_u1", "slack")).toMatchObject({ status: "retry", attempts: 1 });
    await runner.tick(); // too early: no new attempt
    expect(store.notification("t3_u1", "slack")?.attempts).toBe(1);
    for (const wait of [60_000, 300_000, 900_000]) {
      advance(wait);
      await runner.tick();
    }
    expect(store.notification("t3_u1", "slack")).toMatchObject({ status: "failed", attempts: 4 });
    expect(sent).toEqual([]);
  });

  it("waits when the service asks, without counting it as a failure", async () => {
    const { runner, sent, store, advance } = await setup([{ id: "t3_u1", title: "U: CI broke", createdUtc: NOW - HOUR }], {
      fail: (n) => (n === 1 ? new RetryLater(30_000, "rate limited") : null),
    });
    await runner.tick();
    expect(store.notification("t3_u1", "slack")).toMatchObject({ status: "retry", attempts: 0 });
    advance(30_000);
    await runner.tick();
    expect(sent.map((n) => n.itemId)).toEqual(["t3_u1"]);
  });

  it("sends the first digest the next day, not right after install", async () => {
    const { runner, store } = await setup([]);
    const sentDigests: string[] = [];
    (runner as any).o.notifiers[0].sendDigest = async (d: { subject: string }) => void sentDigests.push(d.subject);
    (runner as any).o.live.settings.notify.slack.digest = true;
    await runner.tick();
    expect(sentDigests).toEqual([]);
    store.set("digest:last", "2000-01-01");
    await runner.tick();
    expect(sentDigests).toHaveLength(1);
    await runner.tick();
    expect(sentDigests).toHaveLength(1);
  });
});
