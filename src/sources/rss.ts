// Reddit's public RSS/Atom feeds: no keys, one request per minute per IP.
//
// Never send DNT: 1 (Reddit answers it with 403) and never rotate or fake the
// User-Agent. If Reddit closes this path, virm moves to another legal one; it
// does not play cat and mouse.
import { parseFeed } from "../normalize.js";
import { VERSION } from "../paths.js";
import type { Item } from "../types.js";

export interface RateLimit {
  used: number | null;
  remaining: number | null;
  resetS: number | null;
}

export type FetchResult =
  | { ok: true; status: number; items: Item[]; entries: number; rate: RateLimit; ms: number }
  | { ok: false; status: number | null; error: string; rate: RateLimit | null; ms: number };

export interface Source {
  id: string;
  fetchFeed(url: string): Promise<FetchResult>;
}

const num = (v: string | null) => (v == null || v === "" ? null : Number(v));

export function createRssSource(opts: { fetch?: typeof fetch; timeoutMs?: number } = {}): Source {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const userAgent = `virm/${VERSION} (personal Reddit tracker; +https://github.com/m9ter1a/virm)`;
  return {
    id: "rss",
    async fetchFeed(url) {
      const t0 = Date.now();
      let res: Response;
      let body: string;
      try {
        res = await doFetch(url, {
          headers: { "User-Agent": userAgent, Accept: "application/atom+xml" },
          signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
        });
        body = await res.text();
      } catch (err) {
        return { ok: false, status: null, error: `network: ${(err as Error).message}`, rate: null, ms: Date.now() - t0 };
      }
      const rate: RateLimit = {
        used: num(res.headers.get("x-ratelimit-used")),
        remaining: num(res.headers.get("x-ratelimit-remaining")),
        resetS: num(res.headers.get("x-ratelimit-reset")),
      };
      const ms = Date.now() - t0;
      if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}`, rate, ms };
      try {
        const { items, entries } = parseFeed(body);
        return { ok: true, status: res.status, items, entries, rate, ms };
      } catch (err) {
        return { ok: false, status: res.status, error: `unparseable feed: ${(err as Error).message}`, rate, ms };
      }
    },
  };
}
