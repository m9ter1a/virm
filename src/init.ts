// virm init: from nothing to a working setup in a few questions. The key is
// checked with a real call before it is saved, so a typo shows up now, not
// as an empty inbox later.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { loadTrackers, resolveTracker, SettingsSchema, TrackerSchema, type TrackerInput } from "./config.js";
import { LIQUID_KEY_URL, createLiquidDecider } from "./deciders/liquid.js";
import { EXAMPLE_TRACKERS } from "./examples.js";
import { getPaths } from "./paths.js";
import { buildQuestions, buildState, toAnswers } from "./questions.js";
import { TEMPLATE_IDS, TEMPLATES } from "./templates.js";
import { upsertTracker } from "./trackers-file.js";
import { saveTrackers } from "./config.js";

/** Write or replace one KEY=value line in a .env file, readable only by its owner. */
export function setEnvLine(path: string, key: string, value: string): void {
  const lines = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : [];
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  const at = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (at >= 0) lines[at] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  writeFileSync(path, lines.join("\n") + "\n");
  try {
    chmodSync(path, 0o600);
  } catch {}
}

/** Read a line without echoing it: the key goes to a file, not to the terminal's scrollback. */
function askSecret(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve) => {
    let value = "";
    const done = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stdout.write("\n");
      resolve(value.trim());
    };
    const onData = (chunk: string) => {
      for (const c of chunk) {
        if (c === "\r" || c === "\n") return done();
        if (c === "\u0003") {
          process.stdout.write("\n");
          process.exit(130);
        }
        if (c === "\u007f" || c === "\b") {
          if (value) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        value += c;
        process.stdout.write("*");
      }
    };
    stdin.on("data", onData);
  });
}

async function keyWorks(apiKey: string): Promise<string | null> {
  const settings = SettingsSchema.parse({});
  const t = resolveTracker(TrackerSchema.parse(EXAMPLE_TRACKERS[0]));
  const item = { id: "t3_init", kind: "post" as const, subreddit: "test", author: "virm", title: "virm setup test", text: "", url: "", link: null, createdUtc: Date.now() };
  try {
    const res = await createLiquidDecider({ apiKey, ...settings.liquid }).decide(buildState(item, null), buildQuestions(t));
    toAnswers(res.answers, t);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

export async function init(o: { examples: boolean }): Promise<number> {
  const paths = getPaths();
  mkdirSync(paths.dir, { recursive: true });

  // Not a terminal (a script, CI) or asked for: write the example files and stop.
  if (!process.stdin.isTTY || o.examples) {
    if (!existsSync(paths.config)) writeFileSync(paths.config, JSON.stringify(SettingsSchema.parse({}), null, 2) + "\n");
    if (!existsSync(paths.trackers)) saveTrackers(paths.trackers, EXAMPLE_TRACKERS);
    console.log(`Wrote ${paths.config} and ${paths.trackers} (example trackers, one per goal). Edit them, or run "virm init" in a terminal.`);
    return 0;
  }

  console.log(`virm setup. Files go to ${paths.dir}\n`);

  // 1. The key.
  if (process.env.LIQUID_API_KEY?.trim()) {
    console.log("1. Liquid key: found.\n");
  } else {
    console.log(`1. virm sorts posts with d1, a free decision model from Liquid AI. It needs a free key:`);
    console.log(`   sign up at ${LIQUID_KEY_URL}, open API keys, create one, and paste it here.`);
    for (;;) {
      const key = await askSecret("   Key (hidden, Enter to skip): ");
      if (!key) {
        console.log(`   Skipped. Posts will be collected but not sorted until LIQUID_API_KEY is in ${paths.env}.\n`);
        break;
      }
      process.stdout.write("   Checking it with one real call… ");
      const err = await keyWorks(key);
      if (!err) {
        setEnvLine(paths.env, "LIQUID_API_KEY", key);
        console.log(`works. Saved to ${paths.env}\n`);
        break;
      }
      console.log(`no: ${err}`);
    }
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string, fallback = "") => ((await rl.question(q)).trim() || fallback);
  try {
    // 2. The first tracker.
    const existing = existsSync(paths.trackers) ? loadTrackers(paths.trackers) : [];
    const add = existing.length === 0 || /^y/i.test(await ask(`2. You have ${existing.length} tracker(s). Add another? (y/N) `));
    if (add) {
      console.log(`\n2. A tracker is one thing you want to hear about on Reddit. What is it for?`);
      TEMPLATE_IDS.forEach((id, i) => console.log(`   ${i + 1}. ${TEMPLATES[id].title}: ${TEMPLATES[id].summary}`));
      const pick = Number(await ask("   Number (1): ", "1"));
      const template = TEMPLATE_IDS[pick >= 1 && pick <= TEMPLATE_IDS.length ? pick - 1 : 0];
      const name = await ask("   Short name, e.g. freshclone or Node.js news: ");
      console.log(`   In a sentence or two: who you are and what matters to you. Name the subject broadly first.`);
      console.log(`   Example: ${TEMPLATES[template].aboutExample}`);
      const about = await ask("   About: ");
      console.log(`   What should virm search for? Words people use when they write about it, one per line.`);
      console.log(`   Put an exact phrase in quotes, like "works on my machine". An empty line finishes.`);
      const queries: string[] = [];
      for (;;) {
        const q = await ask(`   Phrase ${queries.length + 1}: `);
        if (!q) break;
        queries.push(q);
      }
      const subs = await ask("   Also read the comments of these subreddits (optional, comma separated): ");
      const tracker: TrackerInput = {
        name,
        template,
        about,
        queries,
        commentSubreddits: subs ? subs.split(/[,\s]+/).filter(Boolean) : undefined,
      };
      const checked = TrackerSchema.safeParse(tracker);
      if (!checked.success) {
        console.log(`\n   That tracker is not complete: ${checked.error.issues.map((i) => `${i.path.join(".") || "tracker"}: ${i.message}`).join("; ")}`);
        console.log(`   Nothing was saved. Run "virm init" again, or add it in the inbox under Trackers.`);
      } else {
        upsertTracker(paths.trackers, tracker);
        console.log(`   Saved "${name}" to ${paths.trackers}.`);
      }
    }

    // 3. Settings.
    if (!existsSync(paths.config)) {
      const user = await ask("\n3. Your Reddit username, so virm skips your own posts (optional): ");
      writeFileSync(paths.config, JSON.stringify(SettingsSchema.parse(user ? { redditUsername: user } : {}), null, 2) + "\n");
    }
  } finally {
    rl.close();
  }

  console.log(`\nDone. Start it with:\n\n  virm start\n\n(or npx @m9ter1a/virm start, if you did not install it)\n`);
  console.log(`The inbox opens in your browser. Urgent posts also show up as desktop notifications;`);
  console.log(`Slack, Discord, email or a webhook: see the README. "virm doctor" checks everything.`);
  return 0;
}
