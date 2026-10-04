// Pure: which of a tracker's queries an item matches, checked locally.
//
// A query is a Reddit search expression: bare words and "quoted phrases",
// all of which must appear. Matching is case-insensitive and on word
// boundaries, so "ci" does not match "special". A bare word also matches
// with a trailing s, so lockfile finds lockfiles.
import type { Tracker } from "./config.js";
import type { Item } from "./types.js";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const OPERATORS = new Set(["and", "or", "not"]);

function termPattern(term: string, phrase: boolean): RegExp {
  const body = term
    .split(/\s+/)
    .map(escape)
    .join("\\s+");
  const plural = phrase || /[^\p{L}]$/u.test(term) ? "" : "(?:e?s)?";
  return new RegExp(`(?<![\\p{L}\\p{N}_])${body}${plural}(?![\\p{L}\\p{N}_])`, "iu");
}

export interface CompiledQuery {
  raw: string;
  patterns: RegExp[];
}

export function compileQuery(raw: string): CompiledQuery {
  const patterns: RegExp[] = [];
  for (const token of raw.match(/"[^"]*"|[^\s()]+/g) ?? []) {
    if (token.startsWith('"')) {
      const inner = token.slice(1, -1).trim();
      if (inner) patterns.push(termPattern(inner, true));
    } else if (!OPERATORS.has(token.toLowerCase())) {
      patterns.push(termPattern(token, false));
    }
  }
  return { raw, patterns };
}

export function queryMatches(q: CompiledQuery, text: string): boolean {
  return q.patterns.length > 0 && q.patterns.every((p) => p.test(text));
}

const cache = new WeakMap<Tracker, CompiledQuery[]>();
function compiled(t: Tracker): CompiledQuery[] {
  let c = cache.get(t);
  if (!c) cache.set(t, (c = t.queries.map(compileQuery)));
  return c;
}

/** The first of the tracker's queries found in the item, or null if none is. */
export function matchedQuery(t: Tracker, item: Item): string | null {
  const text = `${item.title}\n${item.text}`;
  return compiled(t).find((q) => queryMatches(q, text))?.raw ?? null;
}
