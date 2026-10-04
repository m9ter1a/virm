#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { ConfigError, formatIssues, type Tracker } from "./config.js";
import type { ItemRow } from "./db.js";
import { rerouteAll, type StoredAnswers } from "./decide.js";
import { Live, logLine, openRuntime, run, type Runtime } from "./main.js";
import { getPaths, loadEnvFiles, VERSION } from "./paths.js";
import { doctor } from "./doctor.js";
import { init } from "./init.js";
import { buildQuestions, buildState, toAnswers } from "./questions.js";
import { route } from "./route.js";
import { TEMPLATES, TEMPLATE_IDS } from "./templates.js";
import { buildFeeds } from "./trackers.js";
import { GROUPS, GROUP_LABEL, type GroupId, type Item } from "./types.js";
import { openBrowser } from "./web/open.js";
import { startInbox } from "./web/server.js";
import { buildNotifiers } from "./notify/channels.js";

const HELP = `virm ${VERSION} — watch Reddit for what you care about

Usage:
  virm init [--examples]        set up: your Liquid key and a first tracker (--examples writes sample files)
  virm start [--no-open]        collect and classify, with the inbox in your browser, until Ctrl+C
  virm inbox [--no-open]        only the inbox: read and sort what was collected, no polling
  virm list [options]           show classified items, newest first
      --group <g>               urgent | worth | fyi | noise
      --tracker <name>          only items found by this tracker
      --limit <n>               default 20
      --pending                 only items still waiting for the model
  virm feeds                    show every feed: how often it is polled, what Reddit answered
  virm try <tracker> <text>     classify a piece of text as if it were a post, without storing it
  virm reroute                  re-apply thresholds to stored answers (no model calls)
  virm templates                show the tracker templates and their group definitions
  virm doctor [--notify]        check the setup; --notify sends a test to every notification channel
  virm paths                    show where virm keeps its files

Data directory: ${getPaths().dir} (override with VIRM_HOME)
`;

const ICON: Record<GroupId | "pending", string> = { urgent: "🔥", worth: "📌", fyi: "👀", noise: "🗑", pending: "⏳" };

function ago(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`;
}

function parseFlags(args: string[]): { flags: Record<string, string | true>; rest: string[] } {
  const flags: Record<string, string | true> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[a.slice(2)] = next;
        i++;
      } else flags[a.slice(2)] = true;
    } else rest.push(a);
  }
  return { flags, rest };
}

function probLine(a: StoredAnswers["answers"]): string {
  const g = GROUPS.map((k) => `${k} ${a.group.probabilities[k].toFixed(2)}`).join(" · ");
  const sig = Object.entries(a.signals).map(([k, v]) => `${k} ${v.toFixed(2)}`);
  return [g, `on topic ${a.onTopic.toFixed(2)}`, `spam ${a.spam.toFixed(2)}`, ...sig].join(" · ");
}

function printItem(rt: Runtime, item: ItemRow): void {
  const verdicts = rt.store.verdictsFor(item.id);
  const icon = ICON[item.group ?? "pending"];
  const label = item.group ? GROUP_LABEL[item.group] : "Pending";
  const where = item.kind === "comment" ? `comment in r/${item.subreddit}` : `r/${item.subreddit}`;
  const status = item.status === "new" ? "" : ` · ${item.status}`;
  console.log(`${icon} ${label} · ${where} · ${ago(Date.now() - item.createdUtc)} ago · u/${item.author}${status}`);
  console.log(`   ${item.title.slice(0, 120)}`);
  for (const v of verdicts) {
    const phrase = v.phrase ? ` · ${v.phrase}` : " · (matched by Reddit search only)";
    const group = v.grp ? `${v.grp}` : v.state;
    console.log(`   [${v.tracker}${phrase}] → ${group}${v.reason ? ` (${v.reason})` : ""}`);
    if (v.answersJson) console.log(`     ${probLine((JSON.parse(v.answersJson) as StoredAnswers).answers)}`);
    if (v.error) console.log(`     error: ${v.error}`);
  }
  console.log(`   ${item.url}\n`);
}

function findTracker(rt: Runtime, name: string | undefined): Tracker {
  const t = rt.trackers.find((x) => x.name.toLowerCase() === (name ?? "").toLowerCase());
  if (!t) throw new ConfigError(`no tracker named "${name}". Trackers: ${rt.trackers.map((x) => `"${x.name}"`).join(", ") || "none"}`);
  return t;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  const { flags, rest } = parseFlags(args);

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return 0;
  }
  if (cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
    return 0;
  }
  if (cmd === "templates") {
    for (const id of TEMPLATE_IDS) {
      const t = TEMPLATES[id];
      console.log(`${t.id} — ${t.title}\n  ${t.summary}`);
      for (const g of GROUPS) console.log(`  ${ICON[g]} ${GROUP_LABEL[g]}: ${t.groups[g]}`);
      console.log(`  Urgent only within ${t.urgentWithinHours} h of posting.\n`);
    }
    return 0;
  }
  if (cmd === "paths") {
    const p = getPaths();
    console.log(`data      ${p.dir}\nconfig    ${p.config}\ntrackers  ${p.trackers}\ndatabase  ${p.db}\nsecrets   ${p.env}`);
    return 0;
  }

  if (cmd === "init" || cmd === "doctor") {
    const p = getPaths();
    mkdirSync(p.dir, { recursive: true });
    loadEnvFiles([p.env, ".env"]);
    if (cmd === "init") return init({ examples: flags.examples === true });
    return (await doctor({ notify: flags.notify === true })) ? 0 : 1;
  }

  const rt = openRuntime();
  try {
    switch (cmd) {
      case "start":
      case "inbox": {
        const collect = cmd === "start";
        if (collect && rt.trackers.length === 0) throw new ConfigError(`no trackers in ${rt.paths.trackers}. Run "virm init" first.`);
        const live = new Live(rt, logLine);
        const port = flags.port ? Number(flags.port) : rt.settings.port;
        const inbox = await startInbox({ store: rt.store, live, settings: rt.settings, port });
        const { notifiers, status } = buildNotifiers(rt.settings);
        if (collect) {
          const feeds = buildFeeds(rt.trackers);
          console.log(`virm ${VERSION}: ${rt.trackers.length} tracker(s), ${feeds.length} feed(s), one Reddit request per minute.`);
          const on = status.filter((c) => c.on).map((c) => `${c.name} (${rt.settings.notify[c.name].groups.join(", ")})`);
          console.log(`Notifications: ${on.length ? on.join(", ") : "none"}. Daily digest at ${rt.settings.notify.digestAt}.`);
        } else console.log(`virm ${VERSION}: inbox only, not collecting.`);
        console.log(`Inbox: ${inbox.url}   (Ctrl+C to stop)`);
        if (flags["no-open"] !== true && process.stdout.isTTY) openBrowser(inbox.url);
        const ac = new AbortController();
        process.once("SIGINT", () => {
          console.log("\nstopping…");
          ac.abort();
        });
        if (collect) await run(rt, live, { signal: ac.signal, notifiers, inboxUrl: inbox.url });
        else await new Promise((r) => ac.signal.addEventListener("abort", r, { once: true }));
        await inbox.close();
        return 0;
      }
      case "list": {
        const group = flags.group as GroupId | undefined;
        if (group && !GROUPS.includes(group)) throw new ConfigError(`--group must be one of ${GROUPS.join(", ")}`);
        const items = rt.store.queryItems({
          group: flags.pending === true ? "pending" : group,
          view: "all",
          tracker: typeof flags.tracker === "string" ? flags.tracker : undefined,
          limit: Number(flags.limit ?? 20),
        });
        const counts = rt.store.inboxCounts();
        console.log(
          [...GROUPS, "pending" as const].map((g) => `${ICON[g]} ${g} ${counts[g] ?? 0}`).join("   ") + `   ✓ done ${counts.done}\n`,
        );
        for (const item of items) printItem(rt, item);
        if (items.length === 0) console.log("nothing here yet");
        return 0;
      }
      case "feeds": {
        const active = new Set(buildFeeds(rt.trackers).map((f) => f.url));
        const now = Date.now();
        for (const f of rt.store.allFeeds().filter((f) => active.has(f.url))) {
          const u = new URL(f.url);
          const what = f.kind === "search" ? `search "${u.searchParams.get("q")}"` : `${f.kind} ${u.pathname.split("/")[2]}`;
          const last = f.lastFetch ? `${ago(now - f.lastFetch)} ago → ${f.lastStatus ?? "network error"}, ${f.lastCount ?? 0} items` : "never";
          const next = f.nextDue <= now ? "due" : `in ${ago(f.nextDue - now)}`;
          console.log(`${what}\n   every ${Math.round(f.intervalS / 60)} min · last ${last} · next ${next}${f.lastError ? `\n   ⚠ ${f.lastError}` : ""}`);
        }
        const unseen = [...active].filter((u) => !rt.store.getFeed(u)).length;
        if (unseen) console.log(`${unseen} feed(s) not polled yet`);
        return 0;
      }
      case "try": {
        const [name, ...words] = rest;
        const t = findTracker(rt, name);
        const text = words.join(" ").trim();
        if (!text) throw new ConfigError('usage: virm try <tracker> "<text of a post>"');
        if (!rt.decider) throw new ConfigError(rt.deciderMissing!);
        const [title, ...body] = text.split(/\r?\n/);
        const item: Item = { id: "t3_try", kind: "post", subreddit: "test", author: "someone", title, text: body.join("\n"), url: "", link: null, createdUtc: Date.now() };
        const t0 = Date.now();
        const res = await rt.decider.decide(buildState(item, null), buildQuestions(t));
        const answers = toAnswers(res.answers, t);
        const routed = route(answers, 0, t.urgentHours, new Live(rt).thresholdsFor(t.name));
        console.log(`${ICON[routed.group]} ${GROUP_LABEL[routed.group]}${routed.reason ? ` (${routed.reason})` : ""}`);
        console.log(`   ${probLine(answers)}`);
        console.log(`   model ${res.model} · ${res.usage?.input_tokens ?? "?"} input tokens · ${Date.now() - t0} ms`);
        return 0;
      }
      case "reroute": {
        const live = new Live(rt);
        const r = rerouteAll(rt.store, live.trackers, live.thresholdsFor, Date.now());
        console.log(`${r.changed} of ${r.total} verdicts changed group`);
        return 0;
      }
      default:
        console.error(`unknown command "${cmd}"\n`);
        console.log(HELP);
        return 2;
    }
  } finally {
    rt.store.close();
  }
}

/**
 * Close fetch's keep-alive connections, then let the process end by itself.
 * process.exit() with sockets still open crashes Node on Windows
 * ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)").
 */
async function finish(code: number): Promise<void> {
  process.exitCode = code;
  const dispatcher = (globalThis as Record<symbol, { destroy?: () => Promise<void> } | undefined>)[Symbol.for("undici.globalDispatcher.1")];
  await dispatcher?.destroy?.().catch(() => {});
}

main(process.argv.slice(2)).then(finish, (err) => {
  if (err instanceof ConfigError) console.error(`virm: ${err.message}`);
  else if (err?.name === "ZodError") console.error(`virm: invalid settings
${formatIssues(err)}`);
  else console.error(err);
  return finish(1);
});
