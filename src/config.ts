// Settings and trackers: schemas, defaults, and resolving a tracker against its
// template. Parsing is pure; reading and writing files is at the bottom.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { z } from "zod";
import { TEMPLATES, TEMPLATE_IDS, type TemplateId } from "./templates.js";
import { GROUPS, type GroupId } from "./types.js";

/** Reddit search returns an empty feed, with status 200, for q longer than this (measured 2026-10-03). */
export const MAX_QUERY_LENGTH = 512;
/** A post older than this is never Urgent, whatever the tracker says. */
export const HARD_URGENT_MAX_AGE_HOURS = 48;

const stripUser = (s: string) => s.replace(/^\/?u\//i, "");

const subreddit = z.preprocess(
  (v) => (typeof v === "string" ? v.trim().replace(/^\/?r\//i, "") : v),
  z.string().regex(/^[A-Za-z0-9_]{2,21}$/, "not a subreddit name"),
);

const probability = z.number().min(0).max(1);

export const CHANNELS = ["desktop", "slack", "discord", "webhook", "email"] as const;
export type ChannelName = (typeof CHANNELS)[number];
/** Groups a channel may be subscribed to. Noise is not among them. */
export const NOTIFY_GROUPS = ["urgent", "worth", "fyi"] as const;

const channel = (groups: (typeof NOTIFY_GROUPS)[number][], digest: boolean) =>
  z
    .object({
      enabled: z.boolean().default(true),
      groups: z.array(z.enum(NOTIFY_GROUPS)).default(groups),
      /** Also send the daily digest here. */
      digest: z.boolean().default(digest),
    })
    .prefault({});

const groupTexts = z.object(
  Object.fromEntries(GROUPS.map((g) => [g, z.string().min(1).optional()])) as Record<
    GroupId,
    z.ZodOptional<z.ZodString>
  >,
);

export const TrackerSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    template: z.enum(TEMPLATE_IDS).default("help"),
    about: z.string().trim().min(10, "describe what you watch for in a sentence or two"),
    /** Reddit search expressions, matched against posts on all of Reddit. */
    queries: z.array(z.string().trim().min(1).max(MAX_QUERY_LENGTH)).default([]),
    /** Every new post in these subreddits, no query needed. */
    subreddits: z.array(subreddit).default([]),
    /** Comments in these subreddits that match one of the queries. */
    commentSubreddits: z.array(subreddit).default([]),
    excludeSubreddits: z.array(subreddit).default([]),
    excludeAuthors: z.array(z.string().trim().transform(stripUser)).default([]),
    /** Overrides the template's definition of any group. */
    groups: groupTexts.prefault({}),
    /** Extra yes/no questions, added to the template's. */
    signals: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), z.string().min(1)).default({}),
    urgentWithinHours: z.number().positive().max(HARD_URGENT_MAX_AGE_HOURS).optional(),
    /** This tracker's own thresholds. Set here, they win over learned and global ones, and are never learned over. */
    thresholds: z
      .object({
        urgent: probability.optional(),
        spam: probability.optional(),
        offTopic: probability.optional(),
        urgentOnTopic: probability.optional(),
      })
      .prefault({}),
    paused: z.boolean().default(false),
  })
  .refine((t) => t.queries.length > 0 || t.subreddits.length > 0, {
    message: "a tracker needs at least one query or one subreddit",
  })
  .refine((t) => t.commentSubreddits.length === 0 || t.queries.length > 0, {
    message: "commentSubreddits are matched against queries, so they need at least one query",
  });

export const TrackersFileSchema = z.array(TrackerSchema).superRefine((list, ctx) => {
  const seen = new Set<string>();
  for (const [i, t] of list.entries()) {
    const key = t.name.toLowerCase();
    if (seen.has(key)) ctx.addIssue({ code: "custom", path: [i, "name"], message: `duplicate tracker name "${t.name}"` });
    seen.add(key);
  }
});

export type TrackerInput = z.input<typeof TrackerSchema>;
export type TrackerConfig = z.output<typeof TrackerSchema>;

export const SettingsSchema = z.object({
  /** Your Reddit username. Your own posts and comments are skipped. */
  redditUsername: z.string().trim().transform(stripUser).optional(),
  decider: z.enum(["liquid"]).default("liquid"),
  liquid: z
    .object({
      baseURL: z.string().url().default("https://api.liquid.ai/decisions"),
      model: z.string().default("d1:free"),
    })
    .prefault({}),
  thresholds: z
    .object({
      /** Urgent needs at least this P(urgent). When in doubt, demote. */
      urgent: z.number().min(0).max(1).default(0.6),
      /** P(spam) at or above this is Noise. */
      spam: z.number().min(0).max(1).default(0.8),
      /** P(on topic) at or below this is Noise. */
      offTopic: z.number().min(0).max(1).default(0.2),
      /** Urgent also needs at least this P(on topic). Provisional: from 8 cases, to be tuned on labels. */
      urgentOnTopic: z.number().min(0).max(1).default(0.5),
    })
    .prefault({}),
  /** Let each tracker's Urgent threshold follow the user's own labels. */
  learnThresholds: z.boolean().default(true),
  /**
   * Where to call the user, and for which groups. A channel works once its
   * secret is in .env (SLACK_WEBHOOK_URL, DISCORD_WEBHOOK_URL, VIRM_WEBHOOK_URL,
   * SMTP_URL with EMAIL_TO); desktop works out of the box. Noise is not a
   * choice: it never notifies.
   */
  notify: z
    .object({
      desktop: channel(["urgent"], true),
      slack: channel(["urgent"], false),
      discord: channel(["urgent"], false),
      webhook: channel(["urgent"], false),
      email: channel(["urgent"], true),
      /** Local time of the daily digest. */
      digestAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM, e.g. 09:00").default("09:00"),
    })
    .prefault({}),
  port: z.number().int().min(1).max(65535).default(4545),
});
export type Settings = z.output<typeof SettingsSchema>;
export type Thresholds = Settings["thresholds"];

/** A tracker with its template applied: everything the pipeline needs, no optionals. */
export interface Tracker extends TrackerConfig {
  groupTexts: Record<GroupId, string>;
  allSignals: Record<string, string>;
  urgentHours: number;
}

export function resolveTracker(t: TrackerConfig): Tracker {
  const tpl = TEMPLATES[t.template as TemplateId];
  const groupTexts = Object.fromEntries(GROUPS.map((g) => [g, t.groups[g] ?? tpl.groups[g]])) as Record<GroupId, string>;
  return {
    ...t,
    groupTexts,
    allSignals: { ...tpl.signals, ...t.signals },
    urgentHours: Math.min(t.urgentWithinHours ?? tpl.urgentWithinHours, HARD_URGENT_MAX_AGE_HOURS),
  };
}

export function formatIssues(err: z.ZodError): string {
  return err.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
}

export class ConfigError extends Error {}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ConfigError(`${path} is not valid JSON: ${(err as Error).message}`);
  }
}

export function loadSettings(path: string): Settings {
  const raw = existsSync(path) ? readJson(path) : {};
  const parsed = SettingsSchema.safeParse(raw);
  if (!parsed.success) throw new ConfigError(`${path}:\n${formatIssues(parsed.error)}`);
  return parsed.data;
}

export function loadTrackers(path: string): Tracker[] {
  if (!existsSync(path)) return [];
  const parsed = TrackersFileSchema.safeParse(readJson(path));
  if (!parsed.success) throw new ConfigError(`${path}:\n${formatIssues(parsed.error)}`);
  return parsed.data.map(resolveTracker);
}

export function saveTrackers(path: string, trackers: TrackerInput[]): void {
  TrackersFileSchema.parse(trackers);
  writeFileSync(path, JSON.stringify(trackers, null, 2) + "\n");
}
