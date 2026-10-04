// Pure modules: config, trackers, match, prefilter, questions, route, budget.
import { describe, expect, it } from "vitest";
import { afterFailure, afterSuccess, INTERVALS, newFeedState, nextSlot, pickNext } from "../src/budget.js";
import { HARD_URGENT_MAX_AGE_HOURS, SettingsSchema, TrackerSchema, TrackersFileSchema } from "../src/config.js";
import { EXAMPLE_TRACKERS } from "../src/examples.js";
import { linkInfo } from "../src/links.js";
import { effectiveThresholds, LEARN, learnUrgent, type Sample } from "../src/thresholds.js";
import { compileQuery, matchedQuery, queryMatches } from "../src/match.js";
import { prefilter } from "../src/prefilter.js";
import { AnswerShapeError, buildQuestions, buildState, MAX_TEXT_CHARS, toAnswers } from "../src/questions.js";
import { route } from "../src/route.js";
import { TEMPLATES } from "../src/templates.js";
import { buildFeeds, packQueries } from "../src/trackers.js";
import synthetic from "./fixtures/d1/synthetic-systemone.json" with { type: "json" };
import { answers, HOUR, item, tracker } from "./helpers.js";

const thresholds = SettingsSchema.parse({}).thresholds;

describe("config", () => {
  it("fills the template's group definitions and lets a tracker override one", () => {
    const t = tracker({ template: "news", groups: { urgent: "Only a new model release." } });
    expect(t.groupTexts.urgent).toBe("Only a new model release.");
    expect(t.groupTexts.worth).toBe(TEMPLATES.news.groups.worth);
    expect(Object.keys(t.allSignals)).toEqual(Object.keys(TEMPLATES.news.signals));
    expect(t.urgentHours).toBe(TEMPLATES.news.urgentWithinHours);
  });

  it("never lets a tracker make Urgent last longer than the hard cap", () => {
    expect(() => tracker({ urgentWithinHours: 100 })).toThrow();
    expect(tracker({ urgentWithinHours: 48 }).urgentHours).toBe(HARD_URGENT_MAX_AGE_HOURS);
  });

  it("strips r/ and u/ prefixes", () => {
    const t = TrackerSchema.parse({ name: "x", about: "watching something here", queries: ["a"], commentSubreddits: ["r/node"], excludeAuthors: ["/u/bot"] });
    expect(t.commentSubreddits).toEqual(["node"]);
    expect(t.excludeAuthors).toEqual(["bot"]);
  });

  it("rejects trackers that could never find anything", () => {
    expect(TrackerSchema.safeParse({ name: "x", about: "watching something here" }).success).toBe(false);
    expect(TrackerSchema.safeParse({ name: "x", about: "watching something here", subreddits: ["node"], commentSubreddits: ["node"] }).success).toBe(false);
    expect(TrackerSchema.safeParse({ name: "x", about: "watching something here", queries: ["a".repeat(513)] }).success).toBe(false);
  });

  it("rejects duplicate tracker names, case-insensitively", () => {
    const t = { about: "watching something here", queries: ["a"] };
    expect(TrackersFileSchema.safeParse([{ name: "A", ...t }, { name: "a", ...t }]).success).toBe(false);
  });

  it("applies nested defaults to an empty settings file", () => {
    const s = SettingsSchema.parse({});
    expect(s.liquid).toEqual({ baseURL: "https://api.liquid.ai/decisions", model: "d1:free" });
    expect(s.thresholds).toEqual({ urgent: 0.6, spam: 0.8, offTopic: 0.2, urgentOnTopic: 0.5 });
    expect(s.learnThresholds).toBe(true);
  });

  it("ships example trackers that are valid, one per non-custom template", () => {
    const parsed = TrackersFileSchema.parse(EXAMPLE_TRACKERS);
    expect(new Set(parsed.map((t) => t.template))).toEqual(new Set(["help", "news", "mentions", "competitors"]));
  });
});

describe("trackers → feeds", () => {
  it("keeps every packed query within Reddit's 512-character limit", () => {
    const queries = Array.from({ length: 60 }, (_, i) => `"some long phrase number ${i}"`);
    const packs = packQueries(queries);
    expect(packs.length).toBeGreaterThan(1);
    for (const p of packs) expect(p.length).toBeLessThanOrEqual(512);
    expect(packs.join(" OR ").split(" OR ")).toHaveLength(60);
  });

  it("groups multi-term queries so OR does not split them", () => {
    expect(packQueries(['"npm ci" lockfile', "corepack"])).toEqual(['("npm ci" lockfile) OR corepack']);
    expect(packQueries(['"npm ci" lockfile'])).toEqual(['"npm ci" lockfile']);
  });

  it("gives each tracker its own search feed and shares subreddit feeds", () => {
    const a = tracker({ name: "a", queries: ["foo"], commentSubreddits: ["Node"] });
    const b = tracker({ name: "b", queries: ["bar"], commentSubreddits: ["node"], subreddits: ["rust"] });
    const feeds = buildFeeds([a, b, tracker({ name: "c", paused: true })]);
    expect(feeds.filter((f) => f.kind === "search").map((f) => f.trackers)).toEqual([["a"], ["b"]]);
    const comments = feeds.filter((f) => f.kind === "comments");
    expect(comments).toHaveLength(1);
    expect(comments[0].trackers).toEqual(["a", "b"]);
    expect(comments[0].url).toBe("https://www.reddit.com/r/node/comments/.rss?limit=100");
    expect(feeds.find((f) => f.kind === "search")!.url).toContain("type=link");
    expect(feeds.some((f) => f.trackers.includes("c"))).toBe(false);
  });
});

describe("match", () => {
  const m = (q: string, text: string) => queryMatches(compileQuery(q), text);

  it("matches phrases and words case-insensitively on word boundaries", () => {
    expect(m('"works on my machine"', "Well, it WORKS on my\nmachine.")).toBe(true);
    expect(m("ci", "a special case")).toBe(false);
    expect(m("ci", "fails in CI.")).toBe(true);
    expect(m('".nvmrc"', "check your .nvmrc file")).toBe(true);
  });

  it("requires every term of a query and accepts a plural of a bare word", () => {
    expect(m('lockfile "npm ci"', "npm ci complains about lockfiles")).toBe(true);
    expect(m('lockfile "npm ci"', "npm ci is slow")).toBe(false);
  });

  it("ignores operators and grouping", () => {
    expect(m("(lockfile OR yarn)", "the lockfile and yarn")).toBe(true);
  });

  it("reports which query matched, or null when only Reddit's search did", () => {
    const t = tracker();
    expect(matchedQuery(t, item())).toBe('"works on my machine"');
    expect(matchedQuery(t, item({ title: "cloudflare build failed", text: "" }))).toBeNull();
  });
});

describe("prefilter", () => {
  it("skips the user's own posts entirely", () => {
    expect(prefilter(item({ author: "Me" }), tracker(), "me").action).toBe("skip");
  });

  it("sends blocklisted subreddits and authors, and bots, to Noise without the model", () => {
    expect(prefilter(item({ subreddit: "ProgrammerHumor" }), tracker({ excludeSubreddits: ["programmerhumor"] }))).toMatchObject({ action: "noise" });
    expect(prefilter(item({ author: "spammer" }), tracker({ excludeAuthors: ["Spammer"] }))).toMatchObject({ action: "noise" });
    expect(prefilter(item({ author: "AutoModerator" }), tracker())).toMatchObject({ action: "noise" });
    expect(prefilter(item(), tracker()).action).toBe("decide");
  });
});

describe("questions", () => {
  it("asks for a group with the tracker's definitions plus topic, spam and template signals", () => {
    const q = buildQuestions(tracker({ signals: { mentions_ci: "Does the post mention CI?", spam: "ignored: reserved" } }));
    expect(q.group).toMatchObject({ type: "choice", criteria: TEMPLATES.help.groups });
    expect(Object.keys(q)).toEqual(["group", "on_topic", "spam", "asks_help", "has_problem", "mentions_ci"]);
    expect(q.spam).toEqual({ type: "noul", instructions: "Is the post spam, an advertisement, or written by a bot?" });
  });

  it("puts the post in the state without its age, and truncates long text", () => {
    const s = buildState(item({ text: "x".repeat(MAX_TEXT_CHARS + 100) }), '"works on my machine"');
    expect(Object.keys(s)).toEqual(["subreddit", "kind", "title", "text", "matched_search"]);
    expect(s.text.length).toBe(MAX_TEXT_CHARS);
    const c = buildState(item({ kind: "comment", text: "" }), null);
    expect(c.thread_title).toBeDefined();
    expect(c.text).toMatch(/no text/);
  });

  it("tells the model what a post without text links to", () => {
    const s = buildState(item({ text: "", link: "https://abz.global/has-node-24-slowed-our-builds/" }), null);
    expect(s.link).toBe("article: abz.global/has-node-24-slowed-our-builds");
    expect(s.text).toBe("(no text of its own, see link)");
  });

  it("classifies links and accepts only http(s)", () => {
    expect(linkInfo("/r/Discord_Bots/comments/1wtnz1v/i_built_a_custom_jsx_runtime/")).toMatchObject({
      kind: "crosspost",
      url: "https://www.reddit.com/r/Discord_Bots/comments/1wtnz1v/i_built_a_custom_jsx_runtime/",
    });
    expect(linkInfo("https://v.redd.it/abc123")?.kind).toBe("video");
    expect(linkInfo("https://www.youtube.com/watch?v=x")?.kind).toBe("video");
    expect(linkInfo("https://www.reddit.com/gallery/1abc")?.kind).toBe("gallery");
    expect(linkInfo("https://github.com/gkoos/crossflight")).toMatchObject({ kind: "article", label: "github.com/gkoos/crossflight" });
    expect(linkInfo("javascript:alert(1)")).toBeNull();
    expect(linkInfo("data:text/html,<script>")).toBeNull();
    expect(linkInfo("https://example.com/%E0%A4%A")?.label).toBe("example.com/%E0%A4%A");
  });

  it("reads a System One response into Answers", () => {
    const a = toAnswers(synthetic.answers as never, tracker());
    expect(a.group.choice).toBe("urgent");
    expect(a.group.probabilities.urgent).toBe(0.81);
    expect(a.onTopic).toBe(0.93);
    expect(a.signals).toEqual({ asks_help: 0.97, has_problem: 0.88 });
  });

  it("refuses a response without the answers the router needs", () => {
    expect(() => toAnswers({ group: synthetic.answers.group } as never, tracker())).toThrow(AnswerShapeError);
  });
});

describe("route", () => {
  it("sends spam to Noise whatever the group says", () => {
    expect(route(answers({ probs: { urgent: 0.9 }, spam: 0.85 }), 1, 6, thresholds).group).toBe("noise");
  });

  it("sends off-topic posts to Noise whatever the group says, FYI included", () => {
    expect(route(answers({ probs: { urgent: 0.9 }, onTopic: 0.15 }), 1, 6, thresholds).group).toBe("noise");
    // Real d1, 2026-10-04: a post about a music app, for a tracker that follows an AI model: FYI 0.80, on topic 0.04.
    expect(route(answers({ probs: { urgent: 0, worth: 0.1, fyi: 0.8, noise: 0.1 }, onTopic: 0.04 }), 1, 12, thresholds).group).toBe("noise");
  });

  it("needs the post to be clearly on the subject for Urgent", () => {
    // Real d1, 2026-10-04: a regional news digest that names the subject once: urgent 0.88, on topic 0.35.
    expect(route(answers({ probs: { urgent: 0.88, worth: 0.1, fyi: 0.01, noise: 0.01 }, onTopic: 0.35 }), 1, 12, thresholds)).toEqual({
      group: "worth",
      reason: "on topic 0.35 below 0.5 for urgent",
    });
    expect(route(answers({ probs: { urgent: 0.88, worth: 0.1, fyi: 0.01, noise: 0.01 }, onTopic: 0.72 }), 1, 12, thresholds).group).toBe("urgent");
  });

  it("makes a post Urgent only above the threshold, and demotes doubt to Worth a look", () => {
    expect(route(answers({ probs: { urgent: 0.7, worth: 0.2 } }), 1, 6, thresholds).group).toBe("urgent");
    const doubt = route(answers({ probs: { urgent: 0.5, worth: 0.3, fyi: 0.1, noise: 0.1 } }), 1, 6, thresholds);
    expect(doubt).toEqual({ group: "worth", reason: "urgent 0.50 below 0.6" });
  });

  it("demotes an Urgent post that is too old for its tracker, and never keeps one past 48 h", () => {
    expect(route(answers({ probs: { urgent: 0.9 } }), 7, 6, thresholds).group).toBe("worth");
    expect(route(answers({ probs: { urgent: 0.9 } }), 30, 48, thresholds).group).toBe("urgent");
    expect(route(answers({ probs: { urgent: 0.9 } }), 49, 1000, thresholds).group).toBe("worth");
  });

  it("with a low threshold, promotes a likely-urgent post the model ranked second", () => {
    const a = answers({ probs: { urgent: 0.4, worth: 0.45, fyi: 0.1, noise: 0.05 } });
    expect(route(a, 1, 6, { ...thresholds, urgent: 0.35 }).group).toBe("urgent");
    expect(route(a, 1, 6, thresholds).group).toBe("worth");
  });
});

describe("thresholds", () => {
  const sample = (pUrgent: number, label: "urgent" | "worth" | "fyi" | "noise", onTopic = 0.9): Sample => ({ pUrgent, onTopic, spam: 0.01, label });

  it("takes a tracker's own threshold first, then the learned one, then the default", () => {
    const learned = { urgent: 0.75, n: 30, updatedAt: 0 };
    expect(effectiveThresholds(thresholds, tracker(), undefined)).toMatchObject({ urgent: 0.6, urgentSource: "default", learnedFrom: null });
    expect(effectiveThresholds(thresholds, tracker(), learned)).toMatchObject({ urgent: 0.75, urgentSource: "learned", learnedFrom: 30 });
    expect(effectiveThresholds(thresholds, tracker({ thresholds: { urgent: 0.9, spam: 0.5 } }), learned)).toMatchObject({
      urgent: 0.9,
      spam: 0.5,
      offTopic: 0.2,
      urgentSource: "manual",
    });
  });

  it("learns nothing from a handful of labels, or from labels of one kind", () => {
    const few = Array.from({ length: 19 }, (_, i) => sample(0.9, i % 2 ? "urgent" : "fyi"));
    expect(learnUrgent(few, 0.6, thresholds)).toBeNull();
    const allJunk = Array.from({ length: 30 }, () => sample(0.9, "fyi"));
    expect(learnUrgent(allJunk, 0.6, thresholds)).toBeNull();
  });

  it("raises the threshold above confident junk, one bounded step at a time", () => {
    // Real Urgent posts sit at 0.9+, junk the model rated urgent sits at 0.7-0.8.
    const labels = [
      ...Array.from({ length: 6 }, () => sample(0.95, "urgent")),
      ...Array.from({ length: 8 }, () => sample(0.75, "fyi")),
      ...Array.from({ length: 10 }, () => sample(0.1, "noise")),
    ];
    const r = learnUrgent(labels, 0.6, thresholds)!;
    // 0.80 to 0.95 all separate them; the middle keeps a margin on both sides.
    expect(r.best).toBe(0.9);
    expect(r.urgent).toBe(0.7); // 0.6 + the 0.1 step limit
    expect(learnUrgent(labels, r.urgent, thresholds)!.urgent).toBe(0.8);
    expect(learnUrgent(labels, 0.8, thresholds)!.urgent).toBe(0.9);
  });

  it("weighs a needless alert three times a missed one", () => {
    // One junk post at 0.85 and two real ones at 0.8: catching both real ones costs one false alarm.
    const labels = [sample(0.85, "worth"), sample(0.8, "urgent"), sample(0.8, "urgent"), sample(0.95, "urgent"), ...Array.from({ length: 20 }, () => sample(0.05, "noise"))];
    // At 3:1 one false alarm (3) is worse than two misses (2): stay above the junk.
    expect(learnUrgent(labels, 0.9, thresholds)!.best).toBeGreaterThan(0.85);
    // Were both mistakes equal, catching the two real ones would win.
    expect(learnUrgent(labels, 0.9, thresholds, { ...LEARN, falseAlarmCost: 1 })!.best).toBeLessThanOrEqual(0.8);
  });

  it("never leaves its bounds, whatever the labels say", () => {
    const labels = [...Array.from({ length: 5 }, () => sample(0.99, "fyi")), ...Array.from({ length: 20 }, () => sample(0.99, "urgent"))];
    expect(learnUrgent(labels, 0.6, thresholds)!.urgent).toBeLessThanOrEqual(0.95);
    const low = [...Array.from({ length: 5 }, () => sample(0.2, "urgent")), ...Array.from({ length: 20 }, () => sample(0.1, "noise"))];
    expect(learnUrgent(low, 0.6, thresholds)!.urgent).toBeGreaterThanOrEqual(0.5);
  });

  it("does not count as Urgent what the router would stop for being off topic", () => {
    const labels = [
      ...Array.from({ length: 5 }, () => sample(0.9, "urgent")),
      ...Array.from({ length: 10 }, () => sample(0.95, "noise", 0.3)), // confident, but below urgentOnTopic
      ...Array.from({ length: 10 }, () => sample(0.1, "fyi")),
    ];
    expect(learnUrgent(labels, 0.6, thresholds)!.falseAlarms).toBe(0);
  });
});

describe("budget", () => {
  const t0 = Date.UTC(2026, 9, 3, 12, 0, 30);

  it("fires just after the next minute boundary", () => {
    expect(nextSlot(t0)).toBe(Date.UTC(2026, 9, 3, 12, 1, 1, 500));
  });

  it("picks the most overdue feed, search first on a tie", () => {
    const a = { ...newFeedState("a", "comments"), nextDue: t0 - 10 };
    const b = { ...newFeedState("b", "search"), nextDue: t0 - 10 };
    const c = { ...newFeedState("c", "search"), nextDue: t0 + 10 };
    expect(pickNext([a, b, c], t0)?.url).toBe("b");
    expect(pickNext([c], t0)).toBeUndefined();
  });

  it("polls a never-polled feed before feeds that are merely overdue", () => {
    // Found in the first live run: a new feed rated "due now" lost every slot to overdue ones.
    const overdue = { ...newFeedState("old", "search"), nextDue: t0 - 60 * 60_000 };
    expect(pickNext([overdue, newFeedState("new", "comments")], t0)?.url).toBe("new");
  });

  it("polls a busy feed more often, so a full page never skips posts", () => {
    const s = newFeedState("a", "search");
    // 100 items covering two hours: every 5 minutes is plenty.
    expect(afterSuccess(s, { count: 100, limit: 100, oldestCreated: t0 - 2 * HOUR, fresh: 0 }, t0).intervalS).toBe(INTERVALS.search.target);
    // 100 items covering 6 minutes: poll every 3.
    expect(afterSuccess(s, { count: 100, limit: 100, oldestCreated: t0 - 6 * 60_000, fresh: 0 }, t0).intervalS).toBe(180);
    // ...but never more often than the floor.
    expect(afterSuccess(s, { count: 100, limit: 100, oldestCreated: t0 - 60_000, fresh: 0 }, t0).intervalS).toBe(INTERVALS.search.min);
  });

  it("flags an empty search feed, which is how Reddit answers an over-long query", () => {
    const s = afterSuccess(newFeedState("a", "search"), { count: 0, limit: 100, oldestCreated: null, fresh: 0 }, t0);
    expect(s.lastError).toMatch(/empty search feed/);
  });

  it("retries soon after a 429 and backs off exponentially on other failures", () => {
    const s = newFeedState("a", "search");
    expect(afterFailure(s, 429, "HTTP 429", t0).nextDue).toBe(t0 + 2 * 60_000);
    const f1 = afterFailure(s, 403, "HTTP 403", t0);
    const f2 = afterFailure(f1, 403, "HTTP 403", t0);
    expect(f1.nextDue).toBe(t0 + 5 * 60_000);
    expect(f2.nextDue).toBe(t0 + 10 * 60_000);
    let f = f2;
    for (let i = 0; i < 10; i++) f = afterFailure(f, 500, "HTTP 500", t0);
    expect(f.nextDue).toBe(t0 + 60 * 60_000);
  });
});
