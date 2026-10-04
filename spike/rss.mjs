// Day-1 spike: what does Reddit's RSS give us from this IP?
// One request per calendar minute, fired ~1.5 s after the boundary, because
// the limit is 1 request per minute per IP and resets on the minute.
// Raw responses go to test/fixtures/rss/, the summary to spike/rss-results.json.
import { mkdir, writeFile } from "node:fs/promises";

const UA = "virm/0.0.0 (personal Reddit keyword tracker; +https://www.npmjs.com/package/virm)";
const FIXTURES = new URL("../test/fixtures/rss/", import.meta.url);
const RESULTS = new URL("./rss-results.json", import.meta.url);

const PHRASES = [
  '"works on my machine"', '"fails on CI"', '"npm ci"', "lockfile", '"package-lock.json"',
  '"clean install"', '"fresh clone"', '"node_modules"', "postinstall", '"peer dependency"',
  "ERESOLVE", '"engines field"', '"nvm use"', '".nvmrc"', '"case sensitive import"',
  '"github actions failing"', '"builds locally"', '"MCP server"', '"model context protocol"',
  '"editor settings sync"', '"pnpm lockfile"', '"yarn.lock"', "corepack", '"native module"',
  "node-gyp", "prebuild", '"docker build fails"', '"environment variable missing"', "dotenv",
  '"path alias"', '"tsconfig paths"', '"ESM CommonJS"', "ERR_REQUIRE_ESM", '"module not found"',
  '"cannot find module"', '"works locally"', '"deploy fails"', '"vercel build failed"',
  '"netlify build"', '"monorepo workspace"',
];
// A common word nobody else in the list uses. If it shows up in most results,
// Reddit processed the whole OR chain; if it never does, the tail was dropped.
const SENTINEL = "kubernetes";

const search = (q, extra = "") =>
  `https://www.reddit.com/search.rss?q=${encodeURIComponent(q)}&sort=new&limit=100${extra}`;
const orWithSentinel = (n) => [...PHRASES.slice(0, n - 1), SENTINEL].join(" OR ");

const EXPERIMENTS = [
  { name: "search-2", url: search(`lockfile OR "works on my machine"`) },
  { name: "search-2-type-link", url: search(`lockfile OR "works on my machine"`, "&type=link") },
  { name: "node-comments-100", url: "https://www.reddit.com/r/node/comments/.rss?limit=100" },
  { name: "node-new-100", url: "https://www.reddit.com/r/node/new/.rss?limit=100" },
  { name: "or-8", url: search(orWithSentinel(8)), sentinel: true },
  { name: "or-20", url: search(orWithSentinel(20)), sentinel: true },
  { name: "or-41", url: search(orWithSentinel(41)), sentinel: true },
  { name: "javascript-comments-default", url: "https://www.reddit.com/r/javascript/comments/.rss" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForNextMinute() {
  const now = Date.now();
  await sleep(Math.ceil(now / 60_000) * 60_000 + 1_500 - now);
}

const decode = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const pick = (re, s) => (s.match(re) ?? [])[1];

function summarize(xml, exp) {
  const now = Date.now();
  const entries = xml.split("<entry>").slice(1).map((e) => {
    const text = decode(decode(pick(/<content type="html">([\s\S]*?)<\/content>/, e) ?? ""))
      .replace(/<[^>]+>/g, " ").toLowerCase();
    const title = decode(pick(/<title>([\s\S]*?)<\/title>/, e) ?? "").toLowerCase();
    const published = pick(/<published>([^<]+)<\/published>/, e) ?? pick(/<updated>([^<]+)<\/updated>/, e);
    return {
      id: pick(/<id>([^<]+)<\/id>/, e),
      sub: pick(/<category term="([^"]+)"/, e),
      ageH: published ? (now - Date.parse(published)) / 3_600_000 : null,
      hay: `${title} ${text}`,
      textLen: text.length,
    };
  });
  const kinds = {};
  for (const e of entries) {
    const k = (e.id ?? "?").slice(0, 3);
    kinds[k] = (kinds[k] ?? 0) + 1;
  }
  const ages = entries.map((e) => e.ageH).filter((a) => a != null).sort((a, b) => a - b);
  const out = {
    entries: entries.length,
    kinds,
    ageHours: ages.length
      ? { newest: +ages[0].toFixed(2), median: +ages[ages.length >> 1].toFixed(2), oldest: +ages.at(-1).toFixed(2) }
      : null,
    emptyBodies: entries.filter((e) => e.textLen < 5).length,
    subs: Object.entries(
      entries.reduce((m, e) => ((m[e.sub] = (m[e.sub] ?? 0) + 1), m), {}),
    ).sort((a, b) => b[1] - a[1]).slice(0, 8),
  };
  if (exp.sentinel) {
    const posts = entries.filter((e) => e.id?.startsWith("t3_"));
    out.sentinelHits = posts.filter((e) => e.hay.includes(SENTINEL)).length;
    out.posts = posts.length;
    // Which positions in the OR chain produced at least one match.
    const n = exp.url.split("%20OR%20").length;
    const used = [...PHRASES.slice(0, n - 1), SENTINEL];
    out.phrasePositionsMatched = used
      .map((p, i) => [i + 1, p.replace(/"/g, "").toLowerCase()])
      .filter(([, p]) => posts.some((e) => e.hay.includes(p)))
      .map(([i]) => i);
    out.queryLength = decodeURIComponent(exp.url.match(/q=([^&]+)/)[1]).length;
  }
  return out;
}

await mkdir(FIXTURES, { recursive: true });
const results = [];
for (const exp of EXPERIMENTS) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    await waitForNextMinute();
    const sentAt = new Date();
    const t0 = performance.now();
    let res, body;
    try {
      res = await fetch(exp.url, { headers: { "User-Agent": UA, Accept: "application/atom+xml" } });
      body = await res.text();
    } catch (err) {
      results.push({ name: exp.name, attempt, error: String(err) });
      console.log(exp.name, "network error", err);
      break;
    }
    const headers = Object.fromEntries(
      [...res.headers].filter(([k]) => /^(x-ratelimit|date|content-type|cache-control|age|retry-after)/.test(k)),
    );
    const row = {
      name: exp.name,
      attempt,
      url: exp.url,
      sentAt: sentAt.toISOString(),
      ms: Math.round(performance.now() - t0),
      status: res.status,
      headers,
      bytes: body.length,
    };
    if (res.ok) {
      await writeFile(new URL(`${exp.name}.xml`, FIXTURES), body);
      Object.assign(row, summarize(body, exp));
    } else {
      row.bodyStart = body.slice(0, 300);
    }
    results.push(row);
    console.log(JSON.stringify(row));
    await writeFile(RESULTS, JSON.stringify(results, null, 2));
    if (res.status === 403) {
      console.log("403 — stopping, this is the brief's stop condition");
      process.exit(2);
    }
    if (res.status !== 429) break;
  }
}
console.log("done");
