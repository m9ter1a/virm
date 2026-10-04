// virm doctor: is everything in place? Each check says what is wrong and how to fix it.
import { accessSync, constants, existsSync } from "node:fs";
import { loadSettings, loadTrackers, type Settings, type Tracker } from "./config.js";
import { Store } from "./db.js";
import { LIQUID_KEY_URL, createLiquidDecider } from "./deciders/liquid.js";
import { buildNotifiers } from "./notify/channels.js";
import { createDesktopNotifier } from "./notifiers/desktop.js";
import { openUrl } from "./web/open.js";
import type { Notice } from "./notify/format.js";
import { getPaths, VERSION } from "./paths.js";
import { buildQuestions, buildState, toAnswers } from "./questions.js";
import { createRssSource } from "./sources/rss.js";
import { buildFeeds } from "./trackers.js";

type Result = { ok: boolean | "warn"; label: string; detail: string };

const MIN_NODE: [number, number] = [22, 13];

export async function doctor(o: { notify: boolean; log?: (s: string) => void }): Promise<boolean> {
  const log = o.log ?? console.log;
  const out = (r: Result) => log(`${r.ok === true ? "✓" : r.ok === "warn" ? "!" : "✗"} ${r.label.padEnd(14)} ${r.detail}`);
  const paths = getPaths();
  let failed = false;
  const check = async (label: string, fn: () => Promise<Omit<Result, "label">> | Omit<Result, "label">) => {
    let r: Omit<Result, "label">;
    try {
      r = await fn();
    } catch (err) {
      r = { ok: false, detail: (err as Error).message.split("\n").join("\n                 ") };
    }
    if (r.ok === false) failed = true;
    out({ label, ...r });
    return r.ok !== false;
  };

  log(`virm ${VERSION} doctor\n`);
  await check("node", () => {
    const [maj, min] = process.versions.node.split(".").map(Number);
    const ok = maj > MIN_NODE[0] || (maj === MIN_NODE[0] && min >= MIN_NODE[1]);
    return { ok, detail: ok ? `${process.version}` : `${process.version}: virm needs Node ${MIN_NODE.join(".")} or newer` };
  });
  await check("data folder", () => {
    accessSync(paths.dir, constants.W_OK);
    return { ok: true, detail: paths.dir };
  });
  let settings: Settings | undefined;
  await check("config.json", () => {
    settings = loadSettings(paths.config);
    return { ok: true, detail: existsSync(paths.config) ? "valid" : "not created yet, using defaults" };
  });
  let trackers: Tracker[] = [];
  await check("trackers.json", () => {
    trackers = loadTrackers(paths.trackers);
    if (!trackers.length) return { ok: false, detail: 'no trackers. Run "virm init".' };
    const feeds = buildFeeds(trackers).length;
    // One request a minute: past ~30 feeds each is polled less often than every half hour.
    return { ok: feeds > 30 ? "warn" : true, detail: `${trackers.length} tracker(s), ${feeds} feed(s)${feeds > 30 ? ": feeds will be polled slowly" : ""}` };
  });
  await check("database", () => {
    const store = new Store(paths.db);
    const counts = store.inboxCounts();
    store.close();
    return { ok: true, detail: `${Object.values(counts).reduce((a, b) => a + b, 0)} posts` };
  });

  const running = await fetch(`http://127.0.0.1:${settings?.port ?? 4545}/api/state`, { signal: AbortSignal.timeout(1500) })
    .then((r) => (r.ok ? (r.json() as Promise<{ feeds: { failing: number; lastFetch: number | null } }>) : null))
    .catch(() => null);
  await check("reddit", async () => {
    if (running) {
      // virm itself is polling: a request from here would take its minute.
      const f = running.feeds;
      return { ok: f.failing ? "warn" : true, detail: `virm is running; ${f.failing ? `${f.failing} feed(s) failing, see Feeds in the inbox` : "feeds healthy"}` };
    }
    const res = await createRssSource().fetchFeed("https://www.reddit.com/r/reddit/new/.rss?limit=1");
    if (res.ok) return { ok: true, detail: `RSS answers (${res.ms} ms, ${res.rate.remaining ?? "?"} requests left this minute)` };
    if (res.status === 429) return { ok: "warn", detail: "rate limited this minute; another program on this IP is reading Reddit. Try again in a minute." };
    return { ok: false, detail: `${res.error}${res.status === 403 ? ": Reddit refuses this IP or network" : ""}` };
  });

  await check("liquid key", async () => {
    const apiKey = process.env.LIQUID_API_KEY?.trim();
    if (!apiKey) return { ok: false, detail: `LIQUID_API_KEY is not set. Get a free key at ${LIQUID_KEY_URL} and add it to ${paths.env}` };
    if (!trackers.length) return { ok: "warn", detail: "set, not tried: no tracker to try it with" };
    const decider = createLiquidDecider({ apiKey, ...(settings?.liquid ?? { baseURL: "https://api.liquid.ai/decisions", model: "d1:free" }) });
    const t = trackers[0];
    const t0 = Date.now();
    const item = { id: "t3_doctor", kind: "post" as const, subreddit: "test", author: "virm", title: "virm doctor test post", text: "", url: "", link: null, createdUtc: Date.now() };
    const res = await decider.decide(buildState(item, null), buildQuestions(t));
    toAnswers(res.answers, t);
    return { ok: true, detail: `works: ${res.model}, ${Date.now() - t0} ms` };
  });

  const { notifiers, status } = buildNotifiers(settings ?? loadSettings(paths.config));
  for (const s of status) {
    let n = notifiers.find((x) => x.name === s.name);
    await check(`notify ${s.name}`, async () => {
      if (!s.on) return { ok: "warn", detail: `off: ${s.why}` };
      if (!o.notify) return { ok: true, detail: "on (add --notify to send a test)" };
      if (s.name !== "desktop") {
        await n!.send(testNotice(settings?.port ?? 4545), Date.now());
        return { ok: true, detail: "test sent: check that it arrived" };
      }
      // A desktop click is handled by this process, so wait for it here.
      let clicked = false;
      n = createDesktopNotifier(undefined, (url) => {
        clicked = true;
        openUrl(url);
      });
      await n.send(testNotice(settings?.port ?? 4545), Date.now());
      log(`  …               shown. Click it within 20 seconds to check that a click opens the inbox.`);
      for (let i = 0; i < 40 && !clicked; i++) await new Promise((r) => setTimeout(r, 500));
      return clicked
        ? { ok: true, detail: "shown and clicked: the inbox opened" }
        : { ok: "warn", detail: "shown, not clicked in 20 s. If you saw it, desktop notifications work." };
    });
  }
  log(failed ? "\nSomething needs fixing: see ✗ above." : "\nAll good.");
  return !failed;
}

function testNotice(port: number): Notice {
  return {
    itemId: "t3_test",
    group: "urgent",
    tracker: "virm doctor",
    phrase: null,
    kind: "post",
    subreddit: "test",
    author: "virm",
    title: "Test notification from virm doctor. Click it to open the inbox.",
    createdUtc: Date.now(),
    threadUrl: "",
    inboxUrl: `http://127.0.0.1:${port}`,
    link: null,
    score: { group: 1, onTopic: 1, signals: [] },
    copies: 0,
  };
}
