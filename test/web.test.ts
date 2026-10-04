// The inbox server: API, actions and labels, and the defences of a server
// that every web page on this machine can reach.
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsSchema } from "../src/config.js";
import { Store } from "../src/db.js";
import { decideBatch, rerouteAll } from "../src/decide.js";
import type { Decider } from "../src/deciders/types.js";
import { ingest } from "../src/ingest.js";
import { Live, type Runtime } from "../src/main.js";
import { relearn } from "../src/learn.js";
import type { Tracker } from "../src/config.js";
import { buildFeeds } from "../src/trackers.js";
import { startInbox, type Inbox } from "../src/web/server.js";
import { safeUrl } from "../src/web/view.js";
import { HOUR, item, tracker } from "./helpers.js";

const settings = SettingsSchema.parse({});

function decider(byTitle: Record<string, Partial<Record<"urgent" | "worth" | "fyi" | "noise", number>>>): Decider {
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
      };
    },
  };
}

let store: Store;
let inbox: Inbox;
let live: Live;

/** A real Live over an in-memory store; trackers.json does not exist, so it never reloads. */
function liveFor(s: Store, trackers: Tracker[], over: Partial<typeof settings> = {}): Live {
  const rt = {
    paths: { dir: "", config: "", trackers: "missing-trackers.json", db: ":memory:", env: "" },
    settings: { ...settings, ...over },
    trackers,
    store: s,
    decider: null,
    deciderMissing: "test",
  } as Runtime;
  return new Live(rt);
}
const HOSTILE = '<img src=x onerror="alert(1)"> help';

beforeEach(async () => {
  const t = tracker();
  const trackers = new Map([[t.name, t]]);
  store = new Store(":memory:");
  const now = Date.now();
  const search = buildFeeds([t]).find((f) => f.kind === "search")!;
  ingest(
    store,
    search,
    [
      item({ id: "t3_urg", title: "U", createdUtc: now - HOUR }),
      item({ id: "t3_fyi", title: "F", createdUtc: now - 2 * HOUR }),
      item({ id: "t3_xss", title: HOSTILE, createdUtc: now - 3 * HOUR, url: "javascript:alert(1)" }),
      item({ id: "t3_pct", title: "100% coverage", createdUtc: now - 4 * HOUR }),
    ],
    trackers,
    { coldStart: false, now },
  );
  await decideBatch(store, decider({ U: { urgent: 0.9, worth: 0.1 }, F: { fyi: 0.8, noise: 0.2 }, [HOSTILE]: { fyi: 0.7 }, "100% coverage": { fyi: 0.6 } }), trackers, settings.thresholds, {
    limit: 10,
    now: Date.now,
  });
  live = liveFor(store, [t]);
  inbox = await startInbox({ store, live, settings, port: 0 });
});

afterEach(async () => {
  await inbox.close();
  store.close();
});

const get = (path: string) => fetch(`${inbox.url}${path}`);
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${inbox.url}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

/** fetch() will not send a forged Host header, so this goes through node:http. */
function rawRequest(o: { method?: string; path: string; headers: Record<string, string>; body?: string }): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: inbox.port, method: o.method ?? "GET", path: o.path, headers: o.headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end(o.body);
  });
}

describe("inbox page", () => {
  it("serves the page under a strict CSP, also for /i/<id> links from notifications", async () => {
    for (const path of ["/", "/i/t3_urg"]) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
      expect(res.headers.get("content-security-policy")).not.toContain("unsafe-inline");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
    expect((await get("/app.js")).headers.get("content-type")).toMatch(/javascript/);
    expect((await get("/app.css")).headers.get("content-type")).toMatch(/css/);
  });

  it("serves only its own files", async () => {
    expect((await get("/../package.json")).status).toBe(404);
    expect((await get("/web/app.js")).status).toBe(404);
    expect((await get("/%2e%2e/package.json")).status).toBe(404);
  });

  it("never puts text into the page as HTML", () => {
    const js = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
    expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|srcdoc/);
  });

  it("fills elements only through fill(), which drops null instead of printing it", () => {
    // Twice the inbox showed "…ago null": replaceChildren turns a null child into text.
    const js = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
    expect(js.match(/\.replaceChildren\(/g)).toHaveLength(1);
  });
});

describe("inbox API", () => {
  it("counts open items per group", async () => {
    const s = await (await get("/api/state")).json();
    expect(s.counts).toMatchObject({ urgent: 1, fyi: 3, worth: 0, noise: 0, pending: 0, done: 0 });
    expect(s.thresholds.urgent).toBe(0.6);
  });

  it("lists a group with every probability, and returns Reddit text as data, not markup", async () => {
    const { items } = await (await get("/api/items?group=fyi")).json();
    expect(items.map((i: { id: string }) => i.id)).toEqual(["t3_fyi", "t3_xss", "t3_pct"]);
    const xss = items.find((i: { id: string }) => i.id === "t3_xss");
    expect(xss.title).toBe(HOSTILE);
    expect(xss.url).toBe("");
    expect(xss.verdicts[0].answers.group.probabilities.fyi).toBe(0.7);
  });

  it("pages, filters by tracker and searches with LIKE wildcards taken literally", async () => {
    const page = await (await get("/api/items?group=fyi&limit=1")).json();
    expect(page.more).toBe(true);
    const first = page.items[0];
    const next = await (await get(`/api/items?group=fyi&limit=5&before=${first.createdUtc}:${first.id}`)).json();
    expect(next.items.map((i: { id: string }) => i.id)).toEqual(["t3_xss", "t3_pct"]);
    expect((await (await get("/api/items?group=fyi&tracker=nope")).json()).items).toEqual([]);
    expect((await (await get("/api/items?group=fyi&q=100%25")).json()).items.map((i: { id: string }) => i.id)).toEqual(["t3_pct"]);
  });

  it("moves an item to the user's group, logs the label, and keeps it through re-routing", async () => {
    const res = await post("/api/items/t3_urg/action", { type: "label", group: "noise" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.item).toMatchObject({ group: "noise", codeGroup: "urgent", userGroup: "noise" });
    expect(body.counts).toMatchObject({ urgent: 0, noise: 1 });
    expect(store.labelRows("t3_urg")).toEqual([
      expect.objectContaining({ tracker: "freshclone", code_group: "urgent", user_group: "noise", action: "label" }),
    ]);
    const t = tracker();
    rerouteAll(store, new Map([[t.name, t]]), { ...settings.thresholds, urgent: 0.95 }, Date.now());
    expect(store.getItem("t3_urg")).toMatchObject({ grp: "worth", userGrp: "noise", group: "noise" });
  });

  it("marks replied and skipped as done, and reopens to the earlier status", async () => {
    await post("/api/items/t3_urg/action", { type: "replied" });
    expect((await (await get("/api/items?group=urgent")).json()).items).toEqual([]);
    expect((await (await get("/api/items?group=urgent&view=done")).json()).items[0].status).toBe("replied");
    const back = await (await post("/api/items/t3_urg/action", { type: "reopen", status: "backfill" })).json();
    expect(back.item.status).toBe("backfill");
    expect(back.counts.urgent).toBe(1);
  });

  it("records when a post was first looked at", async () => {
    expect((await post("/api/items/t3_urg/seen", {})).status).toBe(204);
    expect((await (await get("/api/items/t3_urg")).json()).seen).toBe(true);
  });

  it("rejects bad input", async () => {
    expect((await post("/api/items/t3_urg/action", { type: "label", group: "important" })).status).toBe(400);
    expect((await post("/api/items/nope/action", { type: "replied" })).status).toBe(400);
    expect((await post("/api/items/t3_missing/action", { type: "replied" })).status).toBe(404);
    expect((await get("/api/items?group=everything")).status).toBe(400);
  });
});

describe("per-tracker thresholds", () => {
  /** 24 labelled posts: real Urgent at 0.95, junk the model rated 0.75, plain noise. */
  async function labelledStore(t: Tracker) {
    const s = new Store(":memory:");
    const trackers = new Map([[t.name, t]]);
    const now = Date.now();
    const items = [
      ...Array.from({ length: 6 }, (_, i) => item({ id: `t3_real${i}`, title: "REAL", createdUtc: now - i * 60_000 })),
      ...Array.from({ length: 8 }, (_, i) => item({ id: `t3_junk${i}`, title: "JUNK", createdUtc: now - i * 60_000 })),
      ...Array.from({ length: 10 }, (_, i) => item({ id: `t3_noise${i}`, title: "NOISE", createdUtc: now - i * 60_000 })),
    ];
    ingest(s, buildFeeds([t]).find((f) => f.kind === "search")!, items, trackers, { coldStart: false, now });
    await decideBatch(s, decider({ REAL: { urgent: 0.95, worth: 0.05 }, JUNK: { urgent: 0.75, fyi: 0.25 }, NOISE: { noise: 0.9, fyi: 0.1 } }), trackers, settings.thresholds, {
      limit: 100,
      now: Date.now,
    });
    for (const it of items) {
      const label = it.title === "REAL" ? "urgent" : it.title === "JUNK" ? "fyi" : "noise";
      s.applyAction(it.id, { type: "label", group: label }, now);
    }
    return s;
  }

  it("learns a tracker's Urgent threshold from its labels and re-routes its posts", async () => {
    const t = tracker();
    const s = await labelledStore(t);
    const l = liveFor(s, [t]);
    expect(s.getItem("t3_junk0")!.grp).toBe("urgent"); // 0.75 passes the default 0.6
    const [change] = relearn(s, l, ["freshclone"], Date.now());
    expect(change).toMatchObject({ tracker: "freshclone", from: 0.6, to: 0.7, n: 24 });
    expect(l.effective("freshclone")).toMatchObject({ urgent: 0.7, urgentSource: "learned", learnedFrom: 24 });
    expect(s.getItem("t3_junk0")!.grp).toBe("urgent"); // 0.75 still passes 0.7: one step at a time
    relearn(s, l, ["freshclone"], Date.now());
    expect(s.getItem("t3_junk0")!.grp).toBe("worth");
    expect(l.effective("freshclone").urgent).toBe(0.8);
    expect(s.getItem("t3_real0")!.grp).toBe("urgent");
    // It survives a restart.
    expect(liveFor(s, [t]).effective("freshclone").urgent).toBe(0.8);
    s.close();
  });

  it("never learns over a threshold set by hand, nor when learning is off", async () => {
    const manual = tracker({ thresholds: { urgent: 0.65 } });
    const s1 = await labelledStore(manual);
    expect(relearn(s1, liveFor(s1, [manual]), ["freshclone"], Date.now())).toEqual([]);
    expect(liveFor(s1, [manual]).effective("freshclone")).toMatchObject({ urgent: 0.65, urgentSource: "manual" });
    s1.close();
    const t = tracker();
    const s2 = await labelledStore(t);
    expect(relearn(s2, liveFor(s2, [t], { learnThresholds: false }), ["freshclone"], Date.now())).toEqual([]);
    s2.close();
  });

  it("reports a learned threshold through the API and the label that moved it", async () => {
    await inbox.close();
    store.close();
    const t = tracker();
    store = await labelledStore(t);
    store.applyAction("t3_noise0", { type: "unlabel" }, Date.now()); // 23 labels: one short
    live = liveFor(store, [t]);
    inbox = await startInbox({ store, live, settings, port: 0 });
    const res = await (await post("/api/items/t3_noise0/action", { type: "label", group: "noise" })).json();
    expect(res.thresholdChanges).toEqual([expect.objectContaining({ tracker: "freshclone", from: 0.6, to: 0.7, n: 24 })]);
    const state = await (await get("/api/state")).json();
    expect(state.trackers[0].thresholds).toMatchObject({ urgent: 0.7, urgentSource: "learned", learnedFrom: 24 });
  });
});

describe("inbox defences", () => {
  it("refuses a Host it does not own, which is how DNS rebinding arrives", async () => {
    expect(await rawRequest({ path: "/api/state", headers: { Host: "attacker.example" } })).toBe(403);
    expect(await rawRequest({ path: "/api/state", headers: { Host: `localhost:${inbox.port}` } })).toBe(200);
  });

  it("refuses writes from another origin or that are not JSON, which is how CSRF arrives", async () => {
    expect((await post("/api/items/t3_urg/action", { type: "replied" }, { Origin: "https://attacker.example" })).status).toBe(403);
    const form = await rawRequest({
      method: "POST",
      path: "/api/items/t3_urg/action",
      headers: { Host: `127.0.0.1:${inbox.port}`, "Content-Type": "text/plain" },
      body: '{"type":"replied"}',
    });
    expect(form).toBe(415);
    expect(store.getItem("t3_urg")!.status).toBe("new");
  });

  it("links only to Reddit over https", () => {
    expect(safeUrl("https://www.reddit.com/r/node/comments/x/")).toBe("https://www.reddit.com/r/node/comments/x/");
    expect(safeUrl("javascript:alert(1)")).toBe("");
    expect(safeUrl("https://evil.example/r/node")).toBe("");
    expect(safeUrl("https://reddit.com.evil.example/")).toBe("");
  });
});
