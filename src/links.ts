// Pure: what a post links to. A third of Reddit posts have no text of their
// own (measured 2026-10-04: 58 of 492 linked an article, 102 an image or
// video), and an article's URL often says what it is about.

export type LinkKind = "article" | "image" | "video" | "gallery" | "crosspost";

export interface LinkInfo {
  url: string;
  kind: LinkKind;
  host: string;
  /** host + path, without the scheme: what a person (or the model) reads. */
  label: string;
}

const REDDIT = "https://www.reddit.com";

/** Absolute http(s) URL, or null. Reddit writes crossposts as /r/… paths. */
export function absoluteUrl(href: string): string | null {
  const raw = href.trim();
  if (raw.startsWith("/r/") || raw.startsWith("/u/") || raw.startsWith("/user/")) return REDDIT + raw;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export function linkInfo(url: string): LinkInfo | null {
  const abs = absoluteUrl(url);
  if (!abs) return null;
  const u = new URL(abs);
  const host = u.hostname.replace(/^www\./, "");
  let kind: LinkKind = "article";
  if (host === "i.redd.it" || host === "preview.redd.it" || host === "i.imgur.com" || /\.(png|jpe?g|gif|webp)$/i.test(u.pathname)) kind = "image";
  else if (host === "v.redd.it" || host === "youtube.com" || host === "youtu.be" || host === "m.youtube.com") kind = "video";
  else if (host.endsWith("reddit.com") && u.pathname.startsWith("/gallery/")) kind = "gallery";
  else if (host.endsWith("reddit.com") && /^\/r\/[^/]+\/comments\//.test(u.pathname)) kind = "crosspost";
  let path = u.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // A malformed %-sequence: keep the path encoded.
  }
  const label = `${host}${path.replace(/\/$/, "")}`.slice(0, 200);
  return { url: abs, kind, host, label };
}
