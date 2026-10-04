// SQLite through the built-in node:sqlite, so npx never compiles anything.
// The database is the source of truth: statuses, dedup, labels, and every
// probability the model returned.
import { DatabaseSync } from "node:sqlite";
import type { FeedState } from "./budget.js";
import type { LearnedThreshold } from "./thresholds.js";
import { DUPLICATE_WINDOW_MS, titleKey } from "./dedup.js";
import type { FeedKind } from "./trackers.js";
import { GROUP_RANK, type GroupId, type Item } from "./types.js";

export type ItemStatus = "new" | "replied" | "skipped" | "backfill";
export type VerdictState = "pending" | "decided" | "prefiltered" | "error";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  subreddit TEXT NOT NULL,
  author TEXT NOT NULL,
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  url TEXT NOT NULL,
  link_url TEXT,
  created_utc INTEGER NOT NULL,
  first_seen INTEGER NOT NULL,
  grp TEXT,
  status TEXT NOT NULL DEFAULT 'new'
);
CREATE INDEX IF NOT EXISTS items_grp ON items (grp, created_utc);

CREATE TABLE IF NOT EXISTS verdicts (
  item_id TEXT NOT NULL REFERENCES items (id),
  tracker TEXT NOT NULL,
  phrase TEXT,
  feed TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  decider TEXT,
  answers_json TEXT,
  grp TEXT,
  reason TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  decided_at INTEGER,
  PRIMARY KEY (item_id, tracker)
);
CREATE INDEX IF NOT EXISTS verdicts_state ON verdicts (state);

CREATE TABLE IF NOT EXISTS labels (
  id INTEGER PRIMARY KEY,
  item_id TEXT NOT NULL,
  tracker TEXT,
  code_group TEXT,
  user_group TEXT,
  action TEXT NOT NULL,
  at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS feeds (
  url TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  interval_s INTEGER NOT NULL,
  next_due INTEGER NOT NULL,
  last_fetch INTEGER,
  last_status INTEGER,
  last_count INTEGER,
  last_fresh INTEGER,
  failures INTEGER NOT NULL DEFAULT 0,
  ever_ok INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  item_id TEXT NOT NULL,
  notifier TEXT NOT NULL,
  sent_at INTEGER,
  status TEXT NOT NULL,
  PRIMARY KEY (item_id, notifier)
);

CREATE TABLE IF NOT EXISTS learned_thresholds (
  tracker TEXT PRIMARY KEY,
  urgent REAL NOT NULL,
  n INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export interface VerdictRow {
  itemId: string;
  tracker: string;
  phrase: string | null;
  state: VerdictState;
  decider: string | null;
  answersJson: string | null;
  grp: GroupId | null;
  reason: string | null;
  error: string | null;
  attempts: number;
}

export interface ItemRow extends Item {
  firstSeen: number;
  /** The group the router picked, from the model's answers. */
  grp: GroupId | null;
  /** The group the user put it in. Wins over grp; re-routing never touches it. */
  userGrp: GroupId | null;
  /** userGrp ?? grp: where the item shows. */
  group: GroupId | null;
  status: ItemStatus;
  seenAt: number | null;
  /** Set on a copy of an earlier post: the id of that post. Copies are not listed or notified. */
  dupOf: string | null;
}

export type ItemView = "open" | "done" | "all";
const OPEN = "('new', 'backfill')";
const DONE = "('replied', 'skipped')";
const DISPLAY = "COALESCE(i.user_grp, i.grp)";

export type InboxAction =
  | { type: "replied" }
  | { type: "skipped" }
  | { type: "reopen"; status?: "new" | "backfill" }
  | { type: "label"; group: GroupId }
  | { type: "unlabel" };

export class NotFoundError extends Error {}

type Row = Record<string, unknown>;

const toItem = (r: Row): ItemRow => ({
  id: r.id as string,
  kind: r.kind as Item["kind"],
  subreddit: r.subreddit as string,
  author: r.author as string,
  title: r.title as string,
  text: r.text as string,
  url: r.url as string,
  link: (r.link_url as string | null) ?? null,
  createdUtc: Number(r.created_utc),
  firstSeen: Number(r.first_seen),
  grp: (r.grp as GroupId | null) ?? null,
  userGrp: (r.user_grp as GroupId | null) ?? null,
  group: ((r.user_grp ?? r.grp) as GroupId | null) ?? null,
  status: r.status as ItemStatus,
  seenAt: r.seen_at == null ? null : Number(r.seen_at),
  dupOf: (r.dup_of as string | null) ?? null,
});

const toVerdict = (r: Row): VerdictRow => ({
  itemId: r.item_id as string,
  tracker: r.tracker as string,
  phrase: (r.phrase as string | null) ?? null,
  state: r.state as VerdictState,
  decider: (r.decider as string | null) ?? null,
  answersJson: (r.answers_json as string | null) ?? null,
  grp: (r.grp as GroupId | null) ?? null,
  reason: (r.reason as string | null) ?? null,
  error: (r.error as string | null) ?? null,
  attempts: Number(r.attempts),
});

const toFeed = (r: Row): FeedState => ({
  url: r.url as string,
  kind: r.kind as FeedKind,
  intervalS: Number(r.interval_s),
  nextDue: Number(r.next_due),
  lastFetch: r.last_fetch == null ? null : Number(r.last_fetch),
  lastStatus: r.last_status == null ? null : Number(r.last_status),
  lastCount: r.last_count == null ? null : Number(r.last_count),
  lastFresh: r.last_fresh == null ? null : Number(r.last_fresh),
  failures: Number(r.failures),
  everOk: Number(r.ever_ok) === 1,
  lastError: (r.last_error as string | null) ?? null,
});

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Columns added after the first databases were created. */
  private migrate(): void {
    const cols = new Set((this.db.prepare("PRAGMA table_info(items)").all() as Row[]).map((r) => r.name as string));
    if (!cols.has("user_grp")) this.db.exec("ALTER TABLE items ADD COLUMN user_grp TEXT");
    if (!cols.has("seen_at")) this.db.exec("ALTER TABLE items ADD COLUMN seen_at INTEGER");
    if (!cols.has("link_url")) this.db.exec("ALTER TABLE items ADD COLUMN link_url TEXT");
    const ncols = new Set((this.db.prepare("PRAGMA table_info(notifications)").all() as Row[]).map((r) => r.name as string));
    if (!ncols.has("attempts"))
      this.db.exec(
        "ALTER TABLE notifications ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0; ALTER TABLE notifications ADD COLUMN next_at INTEGER; ALTER TABLE notifications ADD COLUMN error TEXT;",
      );
    if (!cols.has("title_key")) {
      this.db.exec("ALTER TABLE items ADD COLUMN title_key TEXT; ALTER TABLE items ADD COLUMN dup_of TEXT;");
      this.findDuplicates();
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS items_status ON items (status, created_utc)");
    this.db.exec("CREATE INDEX IF NOT EXISTS items_title_key ON items (title_key, first_seen)");
  }

  /**
   * For databases from before duplicates were tracked: walk the posts in the
   * order they were seen, so an original is always older than its copies.
   */
  private findDuplicates(): void {
    const rows = this.db.prepare("SELECT id, title, first_seen FROM items WHERE kind = 'post' ORDER BY first_seen, id").all() as Row[];
    const originals = new Map<string, { id: string; seen: number }>();
    this.transaction(() => {
      for (const r of rows) {
        const key = titleKey(r.title as string);
        if (!key) continue;
        const seen = Number(r.first_seen);
        const o = originals.get(key);
        const dupOf = o && seen - o.seen <= DUPLICATE_WINDOW_MS ? o.id : null;
        if (!dupOf) originals.set(key, { id: r.id as string, seen });
        this.db.prepare("UPDATE items SET title_key = ?, dup_of = ? WHERE id = ?").run(key, dupOf, r.id as string);
      }
    });
  }

  /** For a post about to be stored: the first earlier post with this title key within the window. */
  private originalFor(key: string, now: number, self: string): string | null {
    const r = this.db
      .prepare(
        `SELECT id FROM items WHERE title_key = ? AND dup_of IS NULL AND id != ? AND first_seen BETWEEN ? AND ?
         ORDER BY first_seen, id LIMIT 1`,
      )
      .get(key, self, now - DUPLICATE_WINDOW_MS, now) as Row | undefined;
    return (r?.id as string | undefined) ?? null;
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // items

  hasItem(id: string): boolean {
    return this.db.prepare("SELECT 1 FROM items WHERE id = ?").get(id) !== undefined;
  }

  insertItem(item: Item, status: ItemStatus, now: number): void {
    const key = item.kind === "post" ? titleKey(item.title) : null;
    const dupOf = key ? this.originalFor(key, now, item.id) : null;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO items (id, kind, subreddit, author, title, text, url, link_url, created_utc, first_seen, status, title_key, dup_of)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(item.id, item.kind, item.subreddit, item.author, item.title, item.text, item.url, item.link, item.createdUtc, now, status, key, dupOf);
  }

  /** Copies of this post in other subreddits. */
  duplicatesOf(id: string): { id: string; subreddit: string; url: string }[] {
    return (this.db.prepare("SELECT id, subreddit, url FROM items WHERE dup_of = ? ORDER BY first_seen").all(id) as Row[]).map((r) => ({
      id: r.id as string,
      subreddit: r.subreddit as string,
      url: r.url as string,
    }));
  }

  /**
   * Items stored before links were read have none. When a feed returns one
   * again, store its link, and if the model judged it on its title alone,
   * send it back to the model. Returns how many verdicts went back.
   */
  fillLink(id: string, link: string): number {
    const r = this.db.prepare("UPDATE items SET link_url = ? WHERE id = ? AND link_url IS NULL").run(link, id);
    if (Number(r.changes) === 0) return 0;
    const item = this.getItem(id);
    if (!item || item.text) return 0;
    const back = this.db.prepare("UPDATE verdicts SET state = 'pending', attempts = 0 WHERE item_id = ? AND state = 'decided'").run(id);
    return Number(back.changes);
  }

  getItem(id: string): ItemRow | undefined {
    const r = this.db.prepare("SELECT * FROM items WHERE id = ?").get(id) as Row | undefined;
    return r && toItem(r);
  }

  /** An item shows once, in the highest group any of its trackers put it in. */
  refreshItemGroup(id: string): void {
    const groups = (this.db
      .prepare("SELECT grp FROM verdicts WHERE item_id = ? AND grp IS NOT NULL")
      .all(id) as Row[]).map((r) => r.grp as GroupId);
    const top = groups.length ? groups.reduce((a, b) => (GROUP_RANK[b] > GROUP_RANK[a] ? b : a)) : null;
    this.db.prepare("UPDATE items SET grp = ? WHERE id = ?").run(top, id);
  }

  /**
   * The inbox list: items in one display group, newest first. Pending means
   * no group yet (waiting for the model, or failed). Paged by created time.
   */
  queryItems(o: {
    group?: GroupId | "pending";
    view?: ItemView;
    tracker?: string;
    q?: string;
    before?: { createdUtc: number; id: string };
    limit: number;
  }): ItemRow[] {
    const where: string[] = ["i.dup_of IS NULL"];
    const args: (string | number)[] = [];
    if (o.group === "pending") where.push(`${DISPLAY} IS NULL`);
    else if (o.group) {
      where.push(`${DISPLAY} = ?`);
      args.push(o.group);
    } else where.push(`${DISPLAY} IS NOT NULL`);
    const view = o.view ?? "open";
    if (view === "open") where.push(`i.status IN ${OPEN}`);
    if (view === "done") where.push(`i.status IN ${DONE}`);
    if (o.tracker) {
      where.push("EXISTS (SELECT 1 FROM verdicts v WHERE v.item_id = i.id AND v.tracker = ?)");
      args.push(o.tracker);
    }
    if (o.q?.trim()) {
      // "!" escapes LIKE's wildcards, so a search for "100%" means the text "100%".
      const like = `%${o.q.trim().replace(/[!%_]/g, (c) => `!${c}`)}%`;
      where.push("(i.title LIKE ? ESCAPE '!' OR i.text LIKE ? ESCAPE '!' OR i.subreddit LIKE ? ESCAPE '!')");
      args.push(like, like, like);
    }
    if (o.before) {
      where.push("(i.created_utc < ? OR (i.created_utc = ? AND i.id < ?))");
      args.push(o.before.createdUtc, o.before.createdUtc, o.before.id);
    }
    const sql = `SELECT i.* FROM items i WHERE ${where.join(" AND ")} ORDER BY i.created_utc DESC, i.id DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...args, o.limit) as Row[]).map(toItem);
  }

  /** Open items per display group, plus how many are pending and done. */
  inboxCounts(): Record<GroupId | "pending" | "done", number> {
    const out = { urgent: 0, worth: 0, fyi: 0, noise: 0, pending: 0, done: 0 };
    const rows = this.db
      .prepare(
        `SELECT CASE WHEN i.status IN ${DONE} THEN 'done' ELSE COALESCE(${DISPLAY}, 'pending') END AS g, COUNT(*) AS n
         FROM items i WHERE i.dup_of IS NULL GROUP BY g`,
      )
      .all() as Row[];
    for (const r of rows) out[r.g as keyof typeof out] = Number(r.n);
    return out;
  }

  /**
   * Apply what the user did in the inbox, and log it in labels: the group the
   * code had picked and the one the user chose. Those rows are the eval set.
   */
  applyAction(id: string, a: InboxAction, now: number): ItemRow {
    return this.transaction(() => {
      const item = this.getItem(id);
      if (!item) throw new NotFoundError(`no item ${id}`);
      if (a.type === "replied" || a.type === "skipped") {
        this.db.prepare("UPDATE items SET status = ? WHERE id = ?").run(a.type, id);
      } else if (a.type === "reopen") {
        this.db.prepare("UPDATE items SET status = ? WHERE id = ?").run(a.status ?? "new", id);
      } else if (a.type === "label") {
        this.db.prepare("UPDATE items SET user_grp = ? WHERE id = ?").run(a.group, id);
      } else {
        this.db.prepare("UPDATE items SET user_grp = NULL WHERE id = ?").run(id);
      }
      const userGroup = a.type === "label" ? a.group : a.type === "unlabel" ? null : item.userGrp;
      const tracker = (this.db
        .prepare("SELECT tracker FROM verdicts WHERE item_id = ? AND grp = ? ORDER BY tracker LIMIT 1")
        .get(id, item.grp ?? "") as Row | undefined)?.tracker as string | undefined;
      this.db
        .prepare("INSERT INTO labels (item_id, tracker, code_group, user_group, action, at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, tracker ?? null, item.grp, userGroup, a.type, now);
      return this.getItem(id)!;
    });
  }

  /** What d1 said about every post of this tracker that the user has put in a group. */
  labeledSamples(tracker: string): { answersJson: string; label: GroupId }[] {
    return (this.db
      .prepare(
        `SELECT v.answers_json AS a, i.user_grp AS label FROM verdicts v JOIN items i ON i.id = v.item_id
         WHERE v.tracker = ? AND v.state = 'decided' AND v.answers_json IS NOT NULL AND i.user_grp IS NOT NULL`,
      )
      .all(tracker) as Row[]).map((r) => ({ answersJson: r.a as string, label: r.label as GroupId }));
  }

  /** Open posts per group that this tracker found, for the trackers page. */
  trackerCounts(tracker: string): Record<GroupId | "pending", number> {
    const out = { urgent: 0, worth: 0, fyi: 0, noise: 0, pending: 0 };
    const rows = this.db
      .prepare(
        `SELECT COALESCE(v.grp, 'pending') AS g, COUNT(*) AS n FROM verdicts v JOIN items i ON i.id = v.item_id
         WHERE v.tracker = ? AND i.status IN ${OPEN} AND i.dup_of IS NULL GROUP BY g`,
      )
      .all(tracker) as Row[];
    for (const r of rows) out[r.g as keyof typeof out] = Number(r.n);
    return out;
  }

  /** Trackers that found this item and have a model verdict on it. */
  decidedTrackers(itemId: string): string[] {
    return (this.db.prepare("SELECT tracker FROM verdicts WHERE item_id = ? AND state = 'decided'").all(itemId) as Row[]).map(
      (r) => r.tracker as string,
    );
  }

  /** A tracker was renamed: its verdicts, labels and learned threshold go with it. */
  renameTracker(from: string, to: string): void {
    this.transaction(() => {
      this.db.prepare("UPDATE verdicts SET tracker = ? WHERE tracker = ?").run(to, from);
      this.db.prepare("UPDATE labels SET tracker = ? WHERE tracker = ?").run(to, from);
      this.db.prepare("UPDATE learned_thresholds SET tracker = ? WHERE tracker = ?").run(to, from);
    });
  }

  allLearned(): Map<string, LearnedThreshold> {
    const rows = this.db.prepare("SELECT * FROM learned_thresholds").all() as Row[];
    return new Map(rows.map((r) => [r.tracker as string, { urgent: Number(r.urgent), n: Number(r.n), updatedAt: Number(r.updated_at) }]));
  }

  setLearned(tracker: string, l: LearnedThreshold): void {
    this.db
      .prepare(
        `INSERT INTO learned_thresholds (tracker, urgent, n, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (tracker) DO UPDATE SET urgent = excluded.urgent, n = excluded.n, updated_at = excluded.updated_at`,
      )
      .run(tracker, l.urgent, l.n, l.updatedAt);
  }

  markSeen(id: string, now: number): void {
    this.db.prepare("UPDATE items SET seen_at = ? WHERE id = ? AND seen_at IS NULL").run(now, id);
  }

  labelRows(itemId: string): Row[] {
    return this.db.prepare("SELECT * FROM labels WHERE item_id = ? ORDER BY id").all(itemId) as Row[];
  }

  // verdicts

  hasVerdict(itemId: string, tracker: string): boolean {
    return this.db.prepare("SELECT 1 FROM verdicts WHERE item_id = ? AND tracker = ?").get(itemId, tracker) !== undefined;
  }

  insertVerdict(v: {
    itemId: string;
    tracker: string;
    phrase: string | null;
    feed: string;
    state: "pending" | "prefiltered";
    grp?: GroupId;
    reason?: string;
    now: number;
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO verdicts (item_id, tracker, phrase, feed, state, grp, reason, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(v.itemId, v.tracker, v.phrase, v.feed, v.state, v.grp ?? null, v.reason ?? null, v.state === "prefiltered" ? v.now : null);
  }

  verdictsFor(itemId: string): VerdictRow[] {
    return (this.db.prepare("SELECT * FROM verdicts WHERE item_id = ? ORDER BY tracker").all(itemId) as Row[]).map(toVerdict);
  }

  /**
   * Items where a query matched locally go first: Reddit's search also stems
   * inside quotes and reads text off images, and on 2026-10-04 up to 89 of
   * 100 results of a search feed matched no query at all, mostly junk. Then
   * newest first, since those can still be Urgent. Only trackers that exist,
   * so a renamed tracker's leftovers cannot clog the queue.
   */
  pendingVerdicts(limit: number, trackers: string[]): (VerdictRow & { item: ItemRow })[] {
    if (trackers.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT v.*, i.id AS i_id FROM verdicts v JOIN items i ON i.id = v.item_id
         WHERE v.state = 'pending' AND v.tracker IN (${trackers.map(() => "?").join(", ")})
         ORDER BY v.phrase IS NULL, i.created_utc DESC LIMIT ?`,
      )
      .all(...trackers, limit) as Row[];
    return rows.map((r) => ({ ...toVerdict(r), item: this.getItem(r.i_id as string)! }));
  }

  saveDecision(itemId: string, tracker: string, d: { decider: string; answersJson: string; grp: GroupId; reason: string | null; now: number }): void {
    this.db
      .prepare(
        `UPDATE verdicts SET state = 'decided', decider = ?, answers_json = ?, grp = ?, reason = ?, error = NULL,
         attempts = attempts + 1, decided_at = ? WHERE item_id = ? AND tracker = ?`,
      )
      .run(d.decider, d.answersJson, d.grp, d.reason, d.now, itemId, tracker);
    this.refreshItemGroup(itemId);
  }

  saveFailure(itemId: string, tracker: string, error: string, giveUp: boolean): void {
    this.db
      .prepare(
        `UPDATE verdicts SET attempts = attempts + 1, error = ?, state = CASE WHEN ? THEN 'error' ELSE state END
         WHERE item_id = ? AND tracker = ?`,
      )
      .run(error, giveUp ? 1 : 0, itemId, tracker);
  }

  decidedVerdicts(): (VerdictRow & { item: ItemRow })[] {
    const rows = this.db
      .prepare(`SELECT v.*, i.id AS i_id FROM verdicts v JOIN items i ON i.id = v.item_id WHERE v.state = 'decided'`)
      .all() as Row[];
    return rows.map((r) => ({ ...toVerdict(r), item: this.getItem(r.i_id as string)! }));
  }

  setVerdictGroup(itemId: string, tracker: string, grp: GroupId, reason: string | null): void {
    this.db.prepare("UPDATE verdicts SET grp = ?, reason = ? WHERE item_id = ? AND tracker = ?").run(grp, reason, itemId, tracker);
  }

  verdictCounts(): Record<string, number> {
    const rows = this.db.prepare("SELECT state, COUNT(*) AS n FROM verdicts GROUP BY state").all() as Row[];
    return Object.fromEntries(rows.map((r) => [r.state as string, Number(r.n)]));
  }

  // feeds

  getFeed(url: string): FeedState | undefined {
    const r = this.db.prepare("SELECT * FROM feeds WHERE url = ?").get(url) as Row | undefined;
    return r && toFeed(r);
  }

  allFeeds(): FeedState[] {
    return (this.db.prepare("SELECT * FROM feeds ORDER BY kind, url").all() as Row[]).map(toFeed);
  }

  saveFeed(s: FeedState): void {
    this.db
      .prepare(
        `INSERT INTO feeds (url, kind, interval_s, next_due, last_fetch, last_status, last_count, last_fresh, failures, ever_ok, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (url) DO UPDATE SET kind = excluded.kind, interval_s = excluded.interval_s, next_due = excluded.next_due,
           last_fetch = excluded.last_fetch, last_status = excluded.last_status, last_count = excluded.last_count,
           last_fresh = excluded.last_fresh, failures = excluded.failures, ever_ok = excluded.ever_ok, last_error = excluded.last_error`,
      )
      .run(s.url, s.kind, s.intervalS, s.nextDue, s.lastFetch, s.lastStatus, s.lastCount, s.lastFresh, s.failures, s.everOk ? 1 : 0, s.lastError);
  }

  // notifications

  /** Posts that could still be worth a notification: open, not a copy, in a group that may notify, seen recently. */
  notifyCandidates(since: number): ItemRow[] {
    return (this.db
      .prepare(
        `SELECT * FROM items WHERE status = 'new' AND dup_of IS NULL AND first_seen >= ?
         AND COALESCE(user_grp, grp) IN ('urgent', 'worth', 'fyi') ORDER BY first_seen`,
      )
      .all(since) as Row[]).map(toItem);
  }

  notification(itemId: string, channel: string): { status: string; attempts: number; nextAt: number | null } | undefined {
    const r = this.db.prepare("SELECT status, attempts, next_at FROM notifications WHERE item_id = ? AND notifier = ?").get(itemId, channel) as
      | Row
      | undefined;
    return r && { status: r.status as string, attempts: Number(r.attempts), nextAt: r.next_at == null ? null : Number(r.next_at) };
  }

  saveNotification(itemId: string, channel: string, n: { status: "sent" | "retry" | "failed"; attempts: number; nextAt?: number; error?: string; at: number }): void {
    this.db
      .prepare(
        `INSERT INTO notifications (item_id, notifier, sent_at, status, attempts, next_at, error) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (item_id, notifier) DO UPDATE SET sent_at = excluded.sent_at, status = excluded.status,
           attempts = excluded.attempts, next_at = excluded.next_at, error = excluded.error`,
      )
      .run(itemId, channel, n.status === "sent" ? n.at : null, n.status, n.attempts, n.nextAt ?? null, n.error ?? null);
  }

  /** Open posts first seen in [since, now), by display group, copies left out. */
  countsSince(since: number, tracker?: string): Record<GroupId, number> {
    const out = { urgent: 0, worth: 0, fyi: 0, noise: 0 };
    const rows = this.db
      .prepare(
        `SELECT COALESCE(i.user_grp, i.grp) AS g, COUNT(*) AS n FROM items i
         WHERE i.first_seen >= ? AND i.dup_of IS NULL AND COALESCE(i.user_grp, i.grp) IS NOT NULL
         ${tracker ? "AND EXISTS (SELECT 1 FROM verdicts v WHERE v.item_id = i.id AND v.tracker = ?)" : ""}
         GROUP BY g`,
      )
      .all(...(tracker ? [since, tracker] : [since])) as Row[];
    for (const r of rows) out[r.g as GroupId] = Number(r.n);
    return out;
  }

  /** Urgent posts nobody has replied to or skipped, newest first. */
  unansweredUrgent(since: number, limit: number): ItemRow[] {
    return (this.db
      .prepare(
        `SELECT * FROM items WHERE status = 'new' AND dup_of IS NULL AND COALESCE(user_grp, grp) = 'urgent' AND first_seen >= ?
         ORDER BY created_utc DESC LIMIT ?`,
      )
      .all(since, limit) as Row[]).map(toItem);
  }

  // kv

  get(key: string): string | undefined {
    const r = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as Row | undefined;
    return r?.value as string | undefined;
  }

  set(key: string, value: string): void {
    this.db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  incr(key: string, by = 1): void {
    this.set(key, String(Number(this.get(key) ?? 0) + by));
  }
}
