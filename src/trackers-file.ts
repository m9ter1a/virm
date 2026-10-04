// Edits to trackers.json from the inbox. The file stays the source of truth
// that people may also edit by hand, so every change is read-modify-validate-
// write on the raw file: nothing derived (template texts, signals) is written
// back, and an invalid result is refused before it touches the disk.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { ConfigError, formatIssues, TrackerSchema, TrackersFileSchema, type TrackerInput } from "./config.js";

type Raw = Record<string, unknown> & { name: string };

function readRaw(path: string): Raw[] {
  if (!existsSync(path)) return [];
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ConfigError(`${path} is not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(data)) throw new ConfigError(`${path} must be a list of trackers`);
  return data as Raw[];
}

function writeRaw(path: string, list: Raw[]): void {
  const parsed = TrackersFileSchema.safeParse(list);
  if (!parsed.success) throw new ConfigError(formatIssues(parsed.error));
  // Write next to it and rename, so a crash mid-write cannot leave half a file.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(list, null, 2) + "\n");
  renameSync(tmp, path);
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function find(list: Raw[], name: string): number {
  const i = list.findIndex((t) => same(String(t.name), name));
  if (i === -1) throw new ConfigError(`no tracker named "${name}"`);
  return i;
}

export type ThresholdPatch = Partial<Record<"urgent" | "spam" | "offTopic" | "urgentOnTopic", number | null>>;

/** Set (a number) or clear (null) a tracker's own thresholds. */
export function setTrackerThresholds(path: string, name: string, patch: ThresholdPatch): void {
  const list = readRaw(path);
  const i = find(list, name);
  const thresholds = { ...((list[i].thresholds as Record<string, number> | undefined) ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete thresholds[k];
    else if (v !== undefined) thresholds[k] = Math.round(v * 100) / 100;
  }
  const next = { ...list[i] };
  if (Object.keys(thresholds).length) next.thresholds = thresholds;
  else delete next.thresholds;
  list[i] = next;
  writeRaw(path, list);
}

/** Add a tracker, or replace the one with this name (renaming it if `previousName` differs). */
export function upsertTracker(path: string, input: TrackerInput | Record<string, unknown>, previousName?: string): void {
  const list = readRaw(path);
  const name = String(input.name ?? "");
  const at = list.findIndex((t) => same(String(t.name), previousName ?? name));
  if (at !== -1 && previousName && !same(previousName, name) && list.some((t) => same(String(t.name), name)))
    throw new ConfigError(`a tracker named "${name}" already exists`);
  // Keep fields the form does not know about, such as hand-set thresholds;
  // a field sent as null is cleared.
  const merged = { ...(at === -1 ? {} : list[at]), ...input } as Raw;
  for (const [k, v] of Object.entries(merged)) if (v === undefined || v === null) delete merged[k];
  const checked = TrackerSchema.safeParse(merged);
  if (!checked.success) throw new ConfigError(formatIssues(checked.error));
  if (at === -1) list.push(merged);
  else list[at] = merged;
  writeRaw(path, list);
}

export function deleteTracker(path: string, name: string): void {
  const list = readRaw(path);
  list.splice(find(list, name), 1);
  writeRaw(path, list);
}

/** The raw entry, as the form edits it. */
export function rawTracker(path: string, name: string): Raw {
  const list = readRaw(path);
  return list[find(list, name)];
}
