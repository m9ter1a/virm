// Pure: a tracker and an item → one System One request, and the response
// back → Answers. The request shape is the protocol's, not an SDK's, so the
// same questions work for d1 over the API and for a local llama-server.
import type { Tracker } from "./config.js";
import { linkInfo } from "./links.js";
import { GROUPS, type Answers, type GroupId, type Item } from "./types.js";

export type Entry = string | { [key: string]: unknown } | null;
export type SystemOneQuestion =
  | { type: "noul"; instructions?: Entry }
  | { type: "choice"; instructions?: Entry; criteria: Record<string, Entry> };
export type SystemOneQuestions = Record<string, SystemOneQuestion>;

/** Raw answers as the protocol returns them. */
export type RawAnswers = Record<
  string,
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: string; [k: string]: unknown }
>;

export const MAX_TEXT_CHARS = 4000;

/** Question names the router depends on. Tracker signals may not reuse them. */
const RESERVED = new Set(["group", "on_topic", "spam"]);

export function buildQuestions(t: Tracker): SystemOneQuestions {
  const questions: SystemOneQuestions = {
    group: {
      type: "choice",
      instructions: `A person watches Reddit with this goal: "${t.about}". Which group does this post belong to for them?`,
      criteria: { ...t.groupTexts },
    },
    // Subject only, not importance: the group answers how much it matters. An
    // earlier wording ("about what this person watches for") made d1 call an
    // opinion post off topic for a tracker that watches releases of the same product.
    on_topic: {
      type: "noul",
      instructions: `Is the post about the same subject as this goal: "${t.about}"? Judge only the subject, not whether the post is important or useful to them. Answer no only if it is about something else, for example the same word in another meaning.`,
    },
    spam: { type: "noul", instructions: "Is the post spam, an advertisement, or written by a bot?" },
  };
  for (const [name, text] of Object.entries(t.allSignals)) {
    if (!RESERVED.has(name)) questions[name] = { type: "noul", instructions: text };
  }
  return questions;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * What the model sees about an item. Age is left out on purpose: freshness is
 * the router's job, and keeping it out means a verdict does not depend on
 * when it was made, which matters for backfill and for re-routing old data.
 */
export function buildState(item: Item, matched: string | null): Record<string, string> {
  const state: Record<string, string> = {
    subreddit: `r/${item.subreddit}`,
    kind: item.kind,
  };
  if (item.kind === "comment") state.thread_title = item.title;
  else state.title = item.title;
  const link = item.link ? linkInfo(item.link) : null;
  if (link) state.link = `${link.kind}: ${link.label}`;
  state.text = item.text
    ? truncate(item.text, MAX_TEXT_CHARS)
    : link
      ? "(no text of its own, see link)"
      : "(no text)";
  if (matched) state.matched_search = matched;
  return state;
}

export class AnswerShapeError extends Error {}

function noulOf(raw: RawAnswers, name: string): number {
  const a = raw[name];
  if (!a || a.type !== "noul" || typeof a.noul !== "number")
    throw new AnswerShapeError(`answer "${name}" is missing or not a yes/no probability`);
  return a.noul;
}

export function toAnswers(raw: RawAnswers, t: Tracker): Answers {
  const g = raw.group;
  if (!g || g.type !== "choice" || typeof g.probabilities !== "object" || g.probabilities === null)
    throw new AnswerShapeError('answer "group" is missing or not a choice');
  const probs = g.probabilities as Record<string, number>;
  const probabilities = Object.fromEntries(GROUPS.map((k) => [k, Number(probs[k] ?? 0)])) as Record<GroupId, number>;
  const choice = GROUPS.includes(g.choice as GroupId)
    ? (g.choice as GroupId)
    : GROUPS.reduce((a, b) => (probabilities[b] > probabilities[a] ? b : a));
  const signals: Record<string, number> = {};
  for (const name of Object.keys(t.allSignals)) {
    if (!RESERVED.has(name) && raw[name]) signals[name] = noulOf(raw, name);
  }
  return {
    group: { choice, confidence: Number(g.confidence ?? probabilities[choice]), probabilities },
    onTopic: noulOf(raw, "on_topic"),
    spam: noulOf(raw, "spam"),
    signals,
  };
}
