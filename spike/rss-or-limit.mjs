// Day-1 spike, follow-up: rss.mjs showed that an OR query of 364 chars works
// and one of 772 chars comes back as an empty feed with status 200. Find the
// boundary, and check whether it is about length or about the number of terms.
// Same pacing as rss.mjs: one request per calendar minute.
import { writeFile } from "node:fs/promises";

const UA = "virm/0.0.0 (personal Reddit keyword tracker; +https://github.com/m9ter1a/virm)";
const RESULTS = new URL("./rss-or-limit-results.json", import.meta.url);
const SENTINEL = "kubernetes";
const PHRASES = [
  '"works on my machine"', '"fails on CI"', '"npm ci"', "lockfile", '"package-lock.json"',
  '"clean install"', '"fresh clone"', '"node_modules"', "postinstall", '"peer dependency"',
  "ERESOLVE", '"engines field"', '"nvm use"', '".nvmrc"', '"case sensitive import"',
  '"github actions failing"', '"builds locally"', '"MCP server"', '"model context protocol"',
  '"editor settings sync"', '"pnpm lockfile"', '"yarn.lock"', "corepack", '"native module"',
];
const SHORT = [
  "vite", "jest", "bun", "deno", "npm", "pnpm", "yarn", "tsx", "swc", "babel", "rollup", "esm",
  "cjs", "vue", "nuxt", "svelte", "astro", "remix", "hono", "koa", "nest", "zod", "trpc", "knex",
  "prisma", "redis", "kafka", "nginx", "caddy", "fly", "render", "netlify", "vercel", "heroku",
  "railway", "turso", "neon", "supabase", "firebase",
];

// Exactly `len` characters, ending with "OR kubernetes", padded with a nonsense phrase.
function queryOfLength(len) {
  const parts = [];
  for (const p of PHRASES) {
    const next = [...parts, p, '"x"', SENTINEL].join(" OR ");
    if (next.length > len) break;
    parts.push(p);
  }
  const base = [...parts, '""', SENTINEL].join(" OR ");
  const pad = "zqx".repeat(200).slice(0, len - base.length);
  const q = [...parts, `"${pad}"`, SENTINEL].join(" OR ");
  if (q.length !== len) throw new Error(`built ${q.length}, wanted ${len}`);
  return { q, terms: parts.length + 2 };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForNextMinute() {
  const now = Date.now();
  await sleep(Math.ceil(now / 60_000) * 60_000 + 1_500 - now);
}

const results = [];
async function probe(label, q, terms) {
  await waitForNextMinute();
  const url = `https://www.reddit.com/search.rss?q=${encodeURIComponent(q)}&sort=new&limit=100&type=link`;
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/atom+xml" } });
  const body = await res.text();
  const entries = body.split("<entry>").length - 1;
  const sentinelHits = body.split("<entry>").slice(1).filter((e) => e.toLowerCase().includes(SENTINEL)).length;
  const row = { label, length: q.length, terms, status: res.status, entries, sentinelHits };
  results.push(row);
  console.log(JSON.stringify(row));
  await writeFile(RESULTS, JSON.stringify(results, null, 2));
  if (res.status === 403 || res.status === 429) {
    console.log("stopping on", res.status);
    process.exit(2);
  }
  return entries > 0 && sentinelHits > 0;
}

const byLength = async (len) => {
  const { q, terms } = queryOfLength(len);
  return probe(`length-${len}`, q, terms);
};

// Length: 364 is known to work, 772 known to fail. Try the classic 512 edge first.
let lo = 364, hi = 772;
if (await byLength(512)) {
  lo = 512;
  if (!(await byLength(513))) hi = 513;
} else hi = 512;
for (let i = 0; i < 4 && hi - lo > 1; i++) {
  const mid = Math.floor((lo + hi) / 2);
  if (await byLength(mid)) lo = mid; else hi = mid;
}
console.log(JSON.stringify({ longestWorking: lo, shortestFailing: hi }));

// Term count: many short terms well under the length that is known to work.
const many = [...SHORT, SENTINEL].join(" OR ");
await probe(`terms-${SHORT.length + 1}`, many, SHORT.length + 1);
console.log("done");
