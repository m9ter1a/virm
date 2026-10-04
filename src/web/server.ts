// The inbox: a small HTTP server on 127.0.0.1 and a page without a build step.
//
// A server on localhost is reachable by every web page the user opens, so:
// - the Host header must name this server, which defeats DNS rebinding;
// - writes must be JSON from this origin, which a cross-site form or fetch
//   cannot produce without a preflight that this server never approves;
// - the page runs under a CSP that allows only its own script, and renders
//   Reddit text with textContent, never as HTML.
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import type { Settings } from "../config.js";
import { NotFoundError, type Store } from "../db.js";
import { relearn } from "../learn.js";
import { ConfigError } from "../config.js";
import { rerouteAll } from "../decide.js";
import { TEMPLATES } from "../templates.js";
import { buildFeeds } from "../trackers.js";
import { deleteTracker, rawTracker, setTrackerThresholds, upsertTracker } from "../trackers-file.js";
import type { Live } from "../main.js";
import { VERSION } from "../paths.js";
import { GROUPS } from "../types.js";
import { feedViews, itemView } from "./view.js";

const WEB_DIR = new URL("../../web/", import.meta.url);
const STATIC: Record<string, [file: string, type: string]> = {
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
  "/favicon.svg": ["favicon.svg", "image/svg+xml"],
};

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

const ID = /^t[13]_[a-z0-9]{1,16}$/i;
const MAX_BODY = 10_000;

const ActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("replied") }),
  z.object({ type: z.literal("skipped") }),
  z.object({ type: z.literal("reopen"), status: z.enum(["new", "backfill"]).optional() }),
  z.object({ type: z.literal("label"), group: z.enum(GROUPS) }),
  z.object({ type: z.literal("unlabel") }),
]);

const nullableProbability = z.number().min(0).max(1).nullable().optional();
const ThresholdPatchSchema = z
  .object({ urgent: nullableProbability, spam: nullableProbability, offTopic: nullableProbability, urgentOnTopic: nullableProbability })
  .strict();
const TrackerSave = z.object({ tracker: z.record(z.string(), z.unknown()), previousName: z.string().optional() });

const ListQuery = z.object({
  group: z.enum([...GROUPS, "pending"]).optional(),
  view: z.enum(["open", "done", "all"]).default("open"),
  tracker: z.string().max(100).optional(),
  q: z.string().max(200).optional(),
  before: z
    .string()
    .regex(/^\d+:t[13]_[a-z0-9]+$/i)
    .transform((s) => {
      const [created, id] = s.split(":");
      return { createdUtc: Number(created), id };
    })
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(60),
});

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface InboxOptions {
  store: Store;
  live: Live;
  settings: Settings;
  port: number;
  now?: () => number;
}

export interface Inbox {
  url: string;
  port: number;
  close(): Promise<void>;
}

export function startInbox(o: InboxOptions): Promise<Inbox> {
  const now = o.now ?? Date.now;
  let port = o.port;
  const hosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = () => new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

  function send(res: ServerResponse, status: number, body: string | Buffer, type: string): void {
    res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type });
    res.end(body);
  }
  const json = (res: ServerResponse, status: number, data: unknown) =>
    send(res, status, JSON.stringify(data), "application/json; charset=utf-8");

  async function readJson(req: IncomingMessage): Promise<unknown> {
    if (!String(req.headers["content-type"] ?? "").startsWith("application/json"))
      throw new HttpError(415, "expected application/json");
    const origin = req.headers.origin;
    if (origin !== undefined && !origins().has(origin)) throw new HttpError(403, "cross-origin request");
    if (req.headers["sec-fetch-site"] === "cross-site") throw new HttpError(403, "cross-site request");
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) throw new HttpError(413, "body too large");
      chunks.push(chunk as Buffer);
    }
    try {
      return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    } catch {
      throw new HttpError(400, "invalid JSON");
    }
  }

  /** Run a write to trackers.json, turn a validation error into a 400, and pick the result up at once. */
  async function writeTrackers(write: () => void): Promise<void> {
    try {
      write();
    } catch (err) {
      if (err instanceof ConfigError) throw new HttpError(400, err.message);
      throw err;
    }
    o.live.reload();
  }

  const view = (id: string) => {
    const item = o.store.getItem(id);
    if (!item) throw new HttpError(404, `no item ${id}`);
    return itemView(item, o.store.verdictsFor(id), o.live.trackers, o.store.duplicatesOf(id));
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hosts().has(String(req.headers.host ?? ""))) throw new HttpError(403, "unexpected Host header");
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (method === "GET" && (path === "/" || /^\/i\/[^/]+$/.test(path))) {
      return send(res, 200, await readFile(new URL("index.html", WEB_DIR)), "text/html; charset=utf-8");
    }
    if (method === "GET" && STATIC[path]) {
      const [file, type] = STATIC[path];
      return send(res, 200, await readFile(new URL(file, WEB_DIR)), type);
    }

    if (method === "GET" && path === "/api/state") {
      o.live.reloadIfChanged();
      const feeds = feedViews(new Map(o.store.allFeeds().map((f) => [f.url, f])), o.live.trackerList);
      return json(res, 200, {
        version: VERSION,
        now: now(),
        counts: o.store.inboxCounts(),
        trackers: o.live.trackerList.map((t) => ({
          name: t.name,
          template: t.template,
          paused: t.paused,
          thresholds: o.live.effective(t.name),
          manual: t.thresholds,
        })),
        learning: o.live.settings.learnThresholds,
        decider: o.live.decider,
        polling: o.live.polling,
        thresholds: o.settings.thresholds,
        model: { calls: Number(o.store.get("model_calls") ?? 0), errors: Number(o.store.get("model_errors") ?? 0) },
        feeds: {
          total: feeds.length,
          failing: feeds.filter((f) => f.failures > 0 || f.lastError).length,
          lastFetch: Math.max(0, ...feeds.map((f) => f.lastFetch ?? 0)) || null,
        },
      });
    }
    if (method === "GET" && path === "/api/feeds") {
      return json(res, 200, feedViews(new Map(o.store.allFeeds().map((f) => [f.url, f])), o.live.trackerList));
    }
    if (method === "GET" && path === "/api/items") {
      const parsed = ListQuery.safeParse(Object.fromEntries(url.searchParams));
      if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      const q = parsed.data;
      const rows = o.store.queryItems({ ...q, limit: q.limit + 1 });
      const items = rows.slice(0, q.limit).map((r) => itemView(r, o.store.verdictsFor(r.id), o.live.trackers, o.store.duplicatesOf(r.id)));
      return json(res, 200, { items, more: rows.length > q.limit });
    }

    // Trackers: read for the trackers page, write back to trackers.json.
    if (method === "GET" && path === "/api/trackers") {
      o.live.reloadIfChanged();
      return json(res, 200, {
        templates: TEMPLATES,
        trackers: o.live.trackerList.map((t) => ({
          raw: rawTracker(o.live.trackersPath, t.name),
          effective: o.live.effective(t.name),
          feeds: buildFeeds([{ ...t, paused: false }]).length,
          counts: o.store.trackerCounts(t.name),
        })),
      });
    }
    if (method === "POST" && path === "/api/trackers") {
      const body = TrackerSave.safeParse(await readJson(req));
      if (!body.success) throw new HttpError(400, "bad tracker");
      const { tracker, previousName } = body.data;
      await writeTrackers(() => upsertTracker(o.live.trackersPath, tracker, previousName));
      const renamedTo = String(tracker.name ?? "").trim();
      if (previousName && renamedTo && previousName !== renamedTo) {
        o.store.renameTracker(previousName, renamedTo);
        o.live.learned = o.store.allLearned();
      }
      return json(res, 200, { ok: true });
    }
    const tm = path.match(/^\/api\/trackers\/([^/]+)\/(thresholds|delete)$/);
    if (tm && method === "POST") {
      const name = decodeURIComponent(tm[1]);
      if (!o.live.trackers.has(name)) throw new HttpError(404, `no tracker named "${name}"`);
      if (tm[2] === "delete") {
        await readJson(req);
        await writeTrackers(() => deleteTracker(o.live.trackersPath, name));
        return json(res, 200, { ok: true });
      }
      const patch = ThresholdPatchSchema.safeParse(await readJson(req));
      if (!patch.success) throw new HttpError(400, "thresholds are numbers from 0 to 1, or null to clear");
      const before = o.live.effective(name);
      await writeTrackers(() => setTrackerThresholds(o.live.trackersPath, name, patch.data));
      const { changed } = rerouteAll(o.store, o.live.trackers, o.live.thresholdsFor, now(), name);
      return json(res, 200, { before, thresholds: o.live.effective(name), moved: changed, counts: o.store.inboxCounts() });
    }

    const m = path.match(/^\/api\/items\/([^/]+)(?:\/(action|seen))?$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (!ID.test(id)) throw new HttpError(400, "bad item id");
      if (method === "GET" && !m[2]) return json(res, 200, view(id));
      if (method === "POST" && m[2] === "seen") {
        await readJson(req);
        o.store.markSeen(id, now());
        res.writeHead(204, SECURITY_HEADERS);
        return void res.end();
      }
      if (method === "POST" && m[2] === "action") {
        const parsed = ActionSchema.safeParse(await readJson(req));
        if (!parsed.success) throw new HttpError(400, "bad action");
        try {
          o.store.applyAction(id, parsed.data, now());
        } catch (err) {
          if (err instanceof NotFoundError) throw new HttpError(404, err.message);
          throw err;
        }
        // A label is evidence about the trackers that found this post.
        const thresholdChanges =
          parsed.data.type === "label" || parsed.data.type === "unlabel" ? relearn(o.store, o.live, o.store.decidedTrackers(id), now()) : [];
        return json(res, 200, { item: view(id), counts: o.store.inboxCounts(), thresholdChanges });
      }
    }
    throw new HttpError(404, "not found");
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : err instanceof ConfigError ? 400 : 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) json(res, status, { error: err instanceof Error ? err.message : String(err) });
      else res.end();
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE")
        reject(new ConfigError(`port ${o.port} is in use. Is virm already running? Another port can be set in config.json ("port").`));
      else reject(err);
    });
    // 127.0.0.1 only: the inbox is never reachable from another machine.
    server.listen(o.port, "127.0.0.1", () => {
      port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
