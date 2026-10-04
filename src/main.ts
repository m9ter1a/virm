// The loop: once a minute, poll the most overdue feed → dedup → match →
// prefilter → store. Alongside it, a worker sends pending items to the
// decision model and routes the answers into groups.
import { mkdirSync, statSync } from "node:fs";
import { MINUTE, afterFailure, afterSuccess, newFeedState, nextSlot, pickNext, type FeedState } from "./budget.js";
import { ConfigError, loadSettings, loadTrackers, type Settings, type Thresholds, type Tracker } from "./config.js";
import { effectiveThresholds, type Effective, type LearnedThreshold } from "./thresholds.js";
import { Store } from "./db.js";
import { decideBatch } from "./decide.js";
import { LIQUID_KEY_URL, createLiquidDecider } from "./deciders/liquid.js";
import type { Decider } from "./deciders/types.js";
import { ingest } from "./ingest.js";
import { getPaths, loadEnvFiles, type Paths } from "./paths.js";
import { createRssSource, type Source } from "./sources/rss.js";
import { buildFeeds, type FeedSpec } from "./trackers.js";
import type { Notifier } from "./notifiers/types.js";
import { NotifyRunner } from "./notify/runner.js";

const PAGE_LIMIT = 100;
/** Resolves after ms, or as soon as the signal aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, Math.max(0, ms));
    signal?.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}

export interface Runtime {
  paths: Paths;
  settings: Settings;
  trackers: Tracker[];
  store: Store;
  decider: Decider | null;
  /** Why there is no decider, when there is none. */
  deciderMissing?: string;
}

export function openRuntime(): Runtime {
  const paths = getPaths();
  mkdirSync(paths.dir, { recursive: true });
  loadEnvFiles([paths.env, ".env"]);
  const settings = loadSettings(paths.config);
  const trackers = loadTrackers(paths.trackers);
  const store = new Store(paths.db);
  const { decider, missing } = makeDecider(settings);
  return { paths, settings, trackers, store, decider, deciderMissing: missing };
}

export function makeDecider(settings: Settings): { decider: Decider | null; missing?: string } {
  const apiKey = process.env.LIQUID_API_KEY?.trim();
  if (!apiKey)
    return { decider: null, missing: `LIQUID_API_KEY is not set. Get a free key at ${LIQUID_KEY_URL} and put it in a .env file.` };
  return { decider: createLiquidDecider({ apiKey, ...settings.liquid }) };
}

const byName = (ts: Tracker[]) => new Map(ts.map((t) => [t.name, t]));

export type DeciderStatus = { state: "ok" | "missing" | "blocked"; message: string | null; id: string | null };

/**
 * What the poller and the inbox share while virm runs: the current trackers
 * (trackers.json is re-read when it changes) and whether the model works.
 */
export class Live {
  trackers: Map<string, Tracker>;
  decider: DeciderStatus;
  polling = false;
  /** Urgent thresholds learned from the user's labels, per tracker. */
  learned: Map<string, LearnedThreshold>;
  private mtime: number;

  constructor(
    private rt: Runtime,
    private log: (s: string) => void = () => {},
  ) {
    this.trackers = byName(rt.trackers);
    this.mtime = mtime(rt.paths.trackers);
    this.learned = rt.store.allLearned();
    this.decider = rt.decider
      ? { state: "ok", message: null, id: rt.decider.id }
      : { state: "missing", message: rt.deciderMissing ?? "no decision model", id: null };
  }

  get trackerList(): Tracker[] {
    return [...this.trackers.values()];
  }

  get settings(): Settings {
    return this.rt.settings;
  }

  /** The thresholds that apply to one tracker, and where its Urgent threshold comes from. */
  effective(tracker: string): Effective {
    const learned = this.rt.settings.learnThresholds ? this.learned.get(tracker) : undefined;
    return effectiveThresholds(this.rt.settings.thresholds, this.trackers.get(tracker), learned);
  }

  /** For decide and reroute. */
  readonly thresholdsFor = (tracker: string): Thresholds => this.effective(tracker);

  get trackersPath(): string {
    return this.rt.paths.trackers;
  }

  /** Re-read trackers.json now: the inbox just wrote it, maybe within the same millisecond. */
  reload(): void {
    this.mtime = -1;
    this.reloadIfChanged();
  }

  reloadIfChanged(): void {
    const m = mtime(this.rt.paths.trackers);
    if (m === this.mtime) return;
    this.mtime = m;
    try {
      this.trackers = byName(loadTrackers(this.rt.paths.trackers));
      this.log(`trackers.json changed: ${this.trackers.size} tracker(s) loaded`);
    } catch (err) {
      this.log(`trackers.json has errors, keeping the previous trackers:\n${(err as Error).message}`);
    }
  }
}

export function describeFeed(f: FeedSpec | FeedState): string {
  const u = new URL(f.url);
  if (f.kind === "search") return `search "${u.searchParams.get("q")}"`;
  return `${f.kind} ${u.pathname.split("/").slice(1, 3).join("/")}`;
}

const stamp = () => new Date().toTimeString().slice(0, 8);
export const logLine = (s: string) => console.log(`${stamp()}  ${s}`);

export async function run(
  rt: Runtime,
  live: Live,
  o: { source?: Source; log?: (s: string) => void; signal?: AbortSignal; notifiers?: Notifier[]; inboxUrl?: string } = {},
): Promise<void> {
  const log = o.log ?? logLine;
  const source = o.source ?? createRssSource();
  const stopped = () => o.signal?.aborted ?? false;
  live.polling = true;

  // Notifications: every few seconds, send what is new and due.
  const notifications = (async () => {
    if (!o.notifiers?.length) return;
    const runner = new NotifyRunner({
      store: rt.store,
      live,
      notifiers: o.notifiers,
      inboxUrl: o.inboxUrl ?? `http://127.0.0.1:${rt.settings.port}`,
      log,
    });
    while (!stopped()) {
      try {
        await runner.tick();
      } catch (err) {
        log(`notifications: ${(err as Error).message}`);
      }
      await sleep(10_000, o.signal);
    }
  })();

  // The decision worker. Runs until stopped; sleeps when there is nothing to do.
  const worker = (async () => {
    if (!rt.decider) {
      log(`no decision model: ${rt.deciderMissing} Items are collected and wait for classification.`);
      return;
    }
    while (!stopped()) {
      const r = await decideBatch(rt.store, rt.decider, live.trackers, live.thresholdsFor, {
        limit: 20,
        now: Date.now,
        onDecided: (line) => log(`  → ${line}`),
      });
      if (r.blocked) {
        live.decider = { ...live.decider, state: "blocked", message: r.blocked };
        log(`decision model unavailable: ${r.blocked}. Retrying in 10 minutes.`);
        await sleep(10 * MINUTE, o.signal);
        continue;
      }
      if (r.decided > 0 && live.decider.state === "blocked") live.decider = { ...live.decider, state: "ok", message: null };
      if (r.decided === 0) await sleep(r.failed ? MINUTE : 5_000, o.signal);
    }
  })();

  let pauseUntil = 0;
  while (!stopped()) {
    await sleep(Math.max(nextSlot(Date.now()), pauseUntil) - Date.now(), o.signal);
    if (stopped()) break;
    live.reloadIfChanged();
    const specs = buildFeeds(live.trackerList);
    const now = Date.now();
    const states = specs.map((s) => rt.store.getFeed(s.url) ?? newFeedState(s.url, s.kind));
    const state = pickNext(states, now);
    if (!state) continue;
    const spec = specs.find((s) => s.url === state.url)!;

    const res = await source.fetchFeed(state.url);
    const done = Date.now();
    if (res.ok) {
      const r = ingest(rt.store, spec, res.items, live.trackers, {
        coldStart: !state.everOk,
        ownUsername: rt.settings.redditUsername,
        now: done,
      });
      const oldest = res.items.length ? Math.min(...res.items.map((i) => i.createdUtc)) : null;
      const next = afterSuccess(state, { count: res.items.length, limit: PAGE_LIMIT, oldestCreated: oldest, fresh: r.pending + r.prefiltered }, done);
      rt.store.saveFeed(next);
      log(
        `${describeFeed(spec)}: ${res.items.length} items, ${r.newItems} new` +
          (!state.everOk && r.newItems ? " (first fetch: stored as backfill)" : "") +
          (r.relinked ? `, ${r.relinked} link post(s) back to the model with their link` : "") +
          `, next in ${Math.round(next.intervalS / 60)} min` +
          (next.lastError ? `  ⚠ ${next.lastError}` : ""),
      );
    } else {
      rt.store.saveFeed(afterFailure(state, res.status, res.error, done));
      log(`${describeFeed(spec)}: ${res.error}`);
      // Someone else on this IP spent the minute, or Reddit is unhappy: skip a slot.
      if (res.status === 429 || res.status === 403) pauseUntil = nextSlot(done) + MINUTE;
    }
  }
  await worker;
  await notifications;
  live.polling = false;
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

export { ConfigError };
