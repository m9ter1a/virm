// Modules with I/O, tested without the network: real RSS responses saved on
// 2026-10-03, SQLite in memory, and a fake fetch for the Liquid API.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SettingsSchema } from "../src/config.js";
import { Store } from "../src/db.js";
import { decideBatch, rerouteAll, type StoredAnswers } from "../src/decide.js";
import { createLiquidDecider } from "../src/deciders/liquid.js";
import { DeciderBlockedError, type Decider } from "../src/deciders/types.js";
import { htmlToText } from "../src/html.js";
import { linkInfo } from "../src/links.js";
import { ingest } from "../src/ingest.js";
import { parseFeed } from "../src/normalize.js";
import { buildQuestions } from "../src/questions.js";
import { createRssSource } from "../src/sources/rss.js";
import { buildFeeds, type FeedSpec } from "../src/trackers.js";
import real from "./fixtures/d1/real-systemone-2026-10-04.json" with { type: "json" };
import { EXAMPLE_TRACKERS } from "../src/examples.js";
import { resolveTracker, TrackerSchema } from "../src/config.js";
import { toAnswers } from "../src/questions.js";
import { HOUR, item, tracker } from "./helpers.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/rss/${name}.xml`, import.meta.url), "utf8");
const thresholds = SettingsSchema.parse({}).thresholds;

describe("normalize", () => {
  it("reads a search feed: posts only, with plain-text bodies", () => {
    const { items, entries } = parseFeed(fixture("search-2-type-link"));
    // Recorded 2026-10-03; usernames replaced and off-subject entries removed before publishing.
    expect(entries).toBe(86);
    expect(items).toHaveLength(86);
    expect(items.every((i) => i.kind === "post" && i.id.startsWith("t3_"))).toBe(true);
    // Authors write "<owner/repo>" and the like; Reddit's own markup must not survive.
    expect(items.some((i) => /<\/?(p|div|a|strong|em|code|pre|table|span)\b|&#39;|&amp;|&quot;/.test(i.text))).toBe(false);
    const image = items.find((i) => i.id === "t3_1wwpsy9")!;
    expect(image.title).toBe("cloudflare build failed. what fixes can i do?");
    expect(image.text).toMatch(/^i'm trying to build my first website with astro/);
    expect(image.text).not.toMatch(/submitted by|\[link\]/);
  });

  it("keeps what a post links to, and nothing for text posts and comments", () => {
    const items = [...parseFeed(fixture("search-2-type-link")).items, ...parseFeed(fixture("node-new-100")).items];
    const image = items.find((i) => i.id === "t3_1wwpsy9")!;
    expect(image.link).toBe("https://i.redd.it/bykuolrlr9th1.png");
    expect(linkInfo(image.link!)).toMatchObject({ kind: "image", host: "i.redd.it" });
    const article = items.find((i) => i.link?.startsWith("https://github.blog/"))!;
    expect(linkInfo(article.link!)).toMatchObject({ kind: "article", host: "github.blog" });
    expect(linkInfo(article.link!)!.label).toContain("node-20-is-no-longer-available-in-github-actions");
    // A text post's [link] points at the post itself: no link.
    expect(items.filter((i) => i.text && i.link === null).length).toBeGreaterThan(100);
    expect(parseFeed(fixture("node-comments-100")).items.every((c) => c.link === null)).toBe(true);
  });

  it("drops subreddit entries the search feed sometimes puts first", () => {
    const { items, entries } = parseFeed(fixture("or-20"));
    expect(entries).toBe(79);
    expect(items).toHaveLength(76); // three subreddit entries
  });

  it("reads a comment feed and takes the thread title out of the entry title", () => {
    const c = parseFeed(fixture("node-comments-100")).items[0];
    expect(c).toMatchObject({ id: "t1_pdoh1bz", kind: "comment", subreddit: "node", author: "user26", title: "Snr FE Dev looking to branch to Full Stack" });
    expect(c.createdUtc).toBe(Date.parse("2026-10-03T20:31:11+00:00"));
  });

  it("returns nothing, not an error, for an empty feed", () => {
    expect(parseFeed(fixture("or-41"))).toEqual({ items: [], entries: 0 });
  });

  it("never lets markup from a post through, scripts included", () => {
    const [x] = parseFeed(fixture("xss")).items;
    expect(x.text).not.toMatch(/<script|onerror|alert\(document/);
    expect(x.text).toContain("hello");
    // Escaped markup the author typed stays visible as text, decoded once.
    expect(x.text).toContain("it <b>works</b> on my machine");
  });

  it("treats a link post without a body as having no text", () => {
    expect(htmlToText('<table><tr><td><a href="x">[link]</a></td></tr></table>')).toBe("");
  });
});

describe("rss source", () => {
  it("sends a real User-Agent and no DNT, and reads the rate-limit headers", async () => {
    let seen: Headers | undefined;
    const source = createRssSource({
      fetch: (async (_url: string, init?: RequestInit) => {
        seen = new Headers(init?.headers);
        return new Response(fixture("node-comments-100"), {
          headers: { "x-ratelimit-used": "1", "x-ratelimit-remaining": "0.0", "x-ratelimit-reset": "57" },
        });
      }) as typeof fetch,
    });
    const r = await source.fetchFeed("https://www.reddit.com/r/node/comments/.rss?limit=100");
    expect(seen!.get("user-agent")).toMatch(/^virm\//);
    expect(seen!.has("dnt")).toBe(false);
    expect(r.ok && r.items.length).toBe(98);
    expect(r.rate).toEqual({ used: 1, remaining: 0, resetS: 57 });
  });

  it("reports HTTP errors instead of throwing", async () => {
    const source = createRssSource({ fetch: (async () => new Response("", { status: 429 })) as unknown as typeof fetch });
    expect(await source.fetchFeed("https://www.reddit.com/x")).toMatchObject({ ok: false, status: 429 });
  });
});

function setup(trackers = [tracker()]) {
  const store = new Store(":memory:");
  const map = new Map(trackers.map((t) => [t.name, t]));
  const feeds = buildFeeds(trackers);
  return { store, map, feeds, search: feeds.find((f) => f.kind === "search")! };
}

describe("ingest", () => {
  const now = Date.UTC(2026, 9, 3, 13);

  it("stores search results as pending verdicts, deduplicated across polls", () => {
    const { store, map, search } = setup();
    const items = [item({ id: "t3_a" }), item({ id: "t3_b", title: "unrelated words", text: "" })];
    const r1 = ingest(store, search, items, map, { coldStart: false, now });
    expect(r1).toEqual({ newItems: 2, pending: 2, prefiltered: 0, relinked: 0 });
    expect(store.verdictsFor("t3_a")[0]).toMatchObject({ tracker: "freshclone", phrase: '"works on my machine"', state: "pending" });
    // Reddit found it, the local check did not: kept, with no phrase.
    expect(store.verdictsFor("t3_b")[0].phrase).toBeNull();
    expect(ingest(store, search, items, map, { coldStart: false, now })).toEqual({ newItems: 0, pending: 0, prefiltered: 0, relinked: 0 });
  });

  it("keeps a comment only when it matches a query locally", () => {
    const t = tracker({ commentSubreddits: ["node"] });
    const { store, map, feeds } = setup([t]);
    const comments = feeds.find((f) => f.kind === "comments")!;
    const r = ingest(store, comments, [item({ id: "t1_yes", kind: "comment" }), item({ id: "t1_no", kind: "comment", title: "x", text: "nothing relevant" })], map, { coldStart: false, now });
    expect(r.newItems).toBe(1);
    expect(store.hasItem("t1_no")).toBe(false);
  });

  it("marks the first fetch of a feed as backfill", () => {
    const { store, map, search } = setup();
    ingest(store, search, [item()], map, { coldStart: true, now });
    expect(store.getItem("t3_abc")!.status).toBe("backfill");
  });

  it("settles excluded subreddits as Noise without the model, and skips the user's own posts", () => {
    const { store, map, search } = setup([tracker({ excludeSubreddits: ["ProgrammerHumor"] })]);
    const r = ingest(store, search, [item({ id: "t3_meme", subreddit: "ProgrammerHumor" }), item({ id: "t3_mine", author: "me" })], map, { coldStart: false, ownUsername: "Me", now });
    expect(r).toEqual({ newItems: 1, pending: 0, prefiltered: 1, relinked: 0 });
    expect(store.getItem("t3_meme")!.grp).toBe("noise");
    expect(store.hasItem("t3_mine")).toBe(false);
  });

  it("keeps one item when two trackers find it, with a verdict for each", () => {
    const a = tracker({ name: "a" });
    const b = tracker({ name: "b" });
    const { store, map } = setup([a, b]);
    const shared: FeedSpec = { url: "u", kind: "search", trackers: ["a", "b"] };
    ingest(store, shared, [item()], map, { coldStart: false, now });
    expect(store.verdictsFor("t3_abc").map((v) => v.tracker)).toEqual(["a", "b"]);
  });
});

function fakeDecider(byTitle: Record<string, Partial<Record<"urgent" | "worth" | "fyi" | "noise", number>>>): Decider {
  return {
    id: "fake",
    async decide(state) {
      const probs = { urgent: 0, worth: 0, fyi: 0, noise: 0, ...byTitle[String(state.title)] };
      const choice = (Object.keys(probs) as (keyof typeof probs)[]).reduce((a, b) => (probs[b] > probs[a] ? b : a));
      return {
        model: "fake",
        answers: {
          group: { type: "choice", choice, confidence: probs[choice], probabilities: probs },
          on_topic: { type: "noul", noul: 0.9 },
          spam: { type: "noul", noul: 0.01 },
          asks_help: { type: "noul", noul: 0.5 },
          has_problem: { type: "noul", noul: 0.5 },
        },
        usage: { input_tokens: 100, output_tokens: 0 },
      };
    },
  };
}

describe("decide", () => {
  it("classifies pending verdicts, stores every probability, and sets the item's group", async () => {
    const { store, map, search } = setup();
    const created = Date.now() - HOUR;
    ingest(store, search, [item({ id: "t3_u", title: "U", createdUtc: created }), item({ id: "t3_f", title: "F", createdUtc: created })], map, { coldStart: false, now: Date.now() });
    const r = await decideBatch(store, fakeDecider({ U: { urgent: 0.8, worth: 0.2 }, F: { fyi: 0.7, worth: 0.3 } }), map, thresholds, { limit: 10, now: Date.now });
    expect(r).toEqual({ decided: 2, failed: 0 });
    expect(store.getItem("t3_u")!.grp).toBe("urgent");
    expect(store.getItem("t3_f")!.grp).toBe("fyi");
    const stored = JSON.parse(store.verdictsFor("t3_u")[0].answersJson!) as StoredAnswers;
    expect(stored.answers.group.probabilities.urgent).toBe(0.8);
    expect(stored.answers.signals).toEqual({ asks_help: 0.5, has_problem: 0.5 });
    expect(store.get("model_calls")).toBe("2");
  });

  it("sends items with a local phrase match to the model before Reddit-only matches", () => {
    const { store, map, search } = setup();
    const now = Date.now();
    ingest(store, search, [item({ id: "t3_junk", title: "build local connections", text: "", createdUtc: now }), item({ id: "t3_real", createdUtc: now - HOUR })], map, { coldStart: false, now });
    expect(store.pendingVerdicts(10, ["freshclone"]).map((v) => v.itemId)).toEqual(["t3_real", "t3_junk"]);
  });

  it("re-routes stored answers when thresholds change, without calling the model", async () => {
    const { store, map, search } = setup();
    ingest(store, search, [item({ title: "U", createdUtc: Date.now() - HOUR })], map, { coldStart: false, now: Date.now() });
    await decideBatch(store, fakeDecider({ U: { urgent: 0.7, worth: 0.3 } }), map, thresholds, { limit: 10, now: Date.now });
    expect(store.getItem("t3_abc")!.grp).toBe("urgent");
    expect(rerouteAll(store, map, { ...thresholds, urgent: 0.75 }, Date.now())).toEqual({ changed: 1, total: 1 });
    expect(store.getItem("t3_abc")!.grp).toBe("worth");
  });

  it("stops at once when the decider is blocked, leaving items pending", async () => {
    const { store, map, search } = setup();
    ingest(store, search, [item()], map, { coldStart: false, now: Date.now() });
    const blocked: Decider = { id: "x", decide: async () => { throw new DeciderBlockedError("Liquid API 401: bad key"); } };
    const r = await decideBatch(store, blocked, map, thresholds, { limit: 10, now: Date.now });
    expect(r.blocked).toMatch(/401/);
    expect(store.verdictsFor("t3_abc")[0].state).toBe("pending");
  });

  it("shows a post shared to several subreddits once, on the first copy seen", () => {
    const { store, map, search } = setup();
    const now = Date.now();
    const title = "Node 26 ships a rewritten test runner and drops support for old Windows";
    ingest(store, search, [item({ id: "t3_first", title, subreddit: "news" })], map, { coldStart: false, now });
    ingest(store, search, [item({ id: "t3_copy1", title: `${title}!`, subreddit: "technology" }), item({ id: "t3_copy2", title: title.toUpperCase(), subreddit: "realtech" })], map, {
      coldStart: false,
      now: now + 3_600_000,
    });
    // Two days later the same title is news again, not a copy.
    ingest(store, search, [item({ id: "t3_later", title, subreddit: "news" })], map, { coldStart: false, now: now + 49 * 3_600_000 });
    // Short titles are too generic to be the same post.
    ingest(store, search, [item({ id: "t3_help1", title: "Help with CI" }), item({ id: "t3_help2", title: "Help with CI" })], map, { coldStart: false, now });
    expect(store.getItem("t3_copy1")!.dupOf).toBe("t3_first");
    expect(store.getItem("t3_copy2")!.dupOf).toBe("t3_first");
    expect(store.getItem("t3_later")!.dupOf).toBeNull();
    expect(store.getItem("t3_help2")!.dupOf).toBeNull();
    expect(store.duplicatesOf("t3_first").map((c) => c.subreddit)).toEqual(["technology", "realtech"]);
    const listed = store.queryItems({ group: "pending", view: "all", limit: 50 }).map((i) => i.id);
    expect(listed).not.toContain("t3_copy1");
    expect(listed).toContain("t3_first");
    expect(store.inboxCounts().pending).toBe(4);
  });

  it("finds copies in an older database, always pointing at the earlier post", () => {
    const path = join(mkdtempSync(join(tmpdir(), "virm-")), "old.db");
    const old = new DatabaseSync(path);
    // An items table as it was before duplicates were tracked.
    old.exec(`CREATE TABLE items (id TEXT PRIMARY KEY, kind TEXT NOT NULL, subreddit TEXT NOT NULL, author TEXT NOT NULL, title TEXT NOT NULL,
      text TEXT NOT NULL, url TEXT NOT NULL, created_utc INTEGER NOT NULL, first_seen INTEGER NOT NULL, grp TEXT, status TEXT NOT NULL DEFAULT 'new')`);
    const title = "Three cloud vendors announce a shared format for model cards";
    const add = old.prepare("INSERT INTO items (id, kind, subreddit, author, title, text, url, created_utc, first_seen) VALUES (?, 'post', ?, 'a', ?, '', 'u', 0, ?)");
    add.run("t3_b", "second", title, 2000); // inserted first, seen later
    add.run("t3_a", "first", title, 1000);
    add.run("t3_c", "third", title, 3000 + 49 * 3_600_000);
    old.close();
    const store = new Store(path);
    expect(store.getItem("t3_a")!.dupOf).toBeNull();
    expect(store.getItem("t3_b")!.dupOf).toBe("t3_a");
    expect(store.getItem("t3_c")!.dupOf).toBeNull(); // over two days later
    store.close();
  });

  it("sends an old link post back to the model once its link is known", async () => {
    const { store, map, search } = setup();
    const now = Date.now();
    const bare = item({ id: "t3_lnk", title: "U", text: "", createdUtc: now - HOUR });
    ingest(store, search, [bare], map, { coldStart: false, now });
    await decideBatch(store, fakeDecider({ U: { fyi: 0.9 } }), map, thresholds, { limit: 10, now: Date.now });
    expect(store.verdictsFor("t3_lnk")[0].state).toBe("decided");
    const r = ingest(store, search, [{ ...bare, link: "https://abz.global/opus-nerfed" }], map, { coldStart: false, now });
    expect(r.relinked).toBe(1);
    expect(store.getItem("t3_lnk")!.link).toBe("https://abz.global/opus-nerfed");
    expect(store.verdictsFor("t3_lnk")[0].state).toBe("pending");
    // Once is enough.
    expect(ingest(store, search, [{ ...bare, link: "https://abz.global/opus-nerfed" }], map, { coldStart: false, now }).relinked).toBe(0);
  });

  it("gives up on an item after repeated failures", async () => {
    const { store, map, search } = setup();
    ingest(store, search, [item()], map, { coldStart: false, now: Date.now() });
    const broken: Decider = { id: "x", decide: async () => { throw new Error("boom"); } };
    for (let i = 0; i < 5; i++) await decideBatch(store, broken, map, thresholds, { limit: 10, now: Date.now });
    expect(store.verdictsFor("t3_abc")[0]).toMatchObject({ state: "error", attempts: 5, error: "boom" });
  });
});

describe("liquid decider", () => {
  it("reads a real d1 response recorded on 2026-10-04", () => {
    const t = resolveTracker(TrackerSchema.parse(EXAMPLE_TRACKERS[0]));
    // The recorded request was built from this tracker; the questions must still match it.
    expect(Object.keys(real.request.questions)).toEqual(Object.keys(buildQuestions(t)));
    const a = toAnswers(real.response.answers as never, t);
    expect(a.group.choice).toBe("urgent");
    expect(a.group.probabilities.urgent).toBeGreaterThan(0.9);
    expect(a.onTopic).toBeGreaterThan(0.9);
    expect(Object.keys(a.signals)).toEqual(["asks_help", "has_problem"]);
    expect(real.response.model).toBe("d1:free");
  });

  it("calls d1 at Liquid's endpoint with the key, the model and the questions", async () => {
    let url = "";
    let init: RequestInit | undefined;
    const d = createLiquidDecider({
      apiKey: "liquid_test",
      baseURL: "https://api.liquid.ai/decisions",
      model: "d1:free",
      fetch: (async (u: string, i?: RequestInit) => {
        url = u;
        init = i;
        return new Response(JSON.stringify(real.response), { headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });
    const questions = buildQuestions(tracker());
    const r = await d.decide({ title: "x" }, questions);
    expect(url).toBe("https://api.liquid.ai/decisions/v1/systemone");
    expect(new Headers(init!.headers).get("authorization")).toBe("Bearer liquid_test");
    const body = JSON.parse(String(init!.body));
    expect(body.model).toBe("d1:free");
    expect(body.state).toEqual({ title: "x" });
    expect(Object.keys(body.questions)).toEqual(Object.keys(questions));
    expect(r.answers.group).toMatchObject({ choice: "urgent" });
    expect(d.id).toBe("liquid:d1:free");
  });

  it("turns billing and auth errors into a blocked decider", async () => {
    const d = createLiquidDecider({
      apiKey: "liquid_test",
      baseURL: "https://api.liquid.ai/decisions",
      model: "d1:free",
      fetch: (async () =>
        new Response(JSON.stringify({ error: { message: "Billing for this organization is still being set up.", type: "insufficient_quota" } }), {
          status: 402,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });
    await expect(d.decide({}, buildQuestions(tracker()))).rejects.toThrow(DeciderBlockedError);
  });
});
