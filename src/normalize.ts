// Pure: an Atom feed from Reddit → Items. Subreddit entries (t5_), which the
// search feed sometimes puts first, and anything else unknown are dropped.
import { XMLParser } from "fast-xml-parser";
import { decodeEntities, htmlToText } from "./html.js";
import { absoluteUrl } from "./links.js";
import type { Item } from "./types.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // Keep content as the raw escaped string; html.ts decodes it exactly once.
  processEntities: true,
  htmlEntities: false,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => name === "entry" || name === "link" || name === "category",
});

type Node = Record<string, unknown>;
const str = (v: unknown): string =>
  typeof v === "string" ? v : v && typeof v === "object" && "#text" in v ? String((v as Node)["#text"]) : "";

export interface ParsedFeed {
  items: Item[];
  /** Entries in the feed, including the ones that were dropped. */
  entries: number;
}

export function parseFeed(xml: string): ParsedFeed {
  const doc = parser.parse(xml) as { feed?: { entry?: Node[] } };
  const entries = doc.feed?.entry ?? [];
  const items: Item[] = [];
  for (const e of entries) {
    const item = toItem(e);
    if (item) items.push(item);
  }
  return { items, entries: entries.length };
}

function toItem(e: Node): Item | null {
  const id = str(e.id);
  const kind = id.startsWith("t3_") ? "post" : id.startsWith("t1_") ? "comment" : null;
  if (!kind) return null;

  const author = str((e.author as Node | undefined)?.name).replace(/^\/u\//, "") || "[deleted]";
  const category = (e.category as Node[] | undefined)?.[0];
  const subreddit = String(category?.["@_term"] ?? "").trim();
  const url = String((e.link as Node[] | undefined)?.[0]?.["@_href"] ?? "");
  let title = decodeEntities(str(e.title));
  // A comment's title is "/u/name on <thread title>".
  if (kind === "comment") title = title.replace(/^\/u\/\S+ on /, "");
  const created = Date.parse(str(e.published) || str(e.updated));
  const content = str(e.content);

  if (!subreddit || !url || Number.isNaN(created)) return null;
  const link = kind === "post" ? postLink(content, url) : null;
  return { id, kind, subreddit, author, title, text: htmlToText(content), url, link, createdUtc: created };
}

/**
 * A post's footer has "[link]" pointing at what the post links to; for a text
 * post that is the post itself. Crossposts come as /r/… paths.
 */
function postLink(html: string, permalink: string): string | null {
  const m = html.match(/<a href="([^"]+)">\[link\]<\/a>/);
  if (!m) return null;
  const abs = absoluteUrl(decodeEntities(m[1]));
  if (!abs) return null;
  const bare = (u: string) => u.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
  return bare(abs) === bare(permalink) ? null : abs;
}
