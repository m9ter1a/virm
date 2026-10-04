// Sends what dispatch says should be sent, one channel at a time, slowly
// enough for each service, and remembers every send so nothing goes twice.
import type { Store, ItemRow } from "../db.js";
import type { StoredAnswers } from "../decide.js";
import { linkInfo } from "../links.js";
import type { Live } from "../main.js";
import { RetryLater, type Notifier } from "../notifiers/types.js";
import { buildFeeds } from "../trackers.js";
import { safeUrl } from "../web/view.js";
import { digestDue, digestMessage, localDay, type DigestData } from "./digest.js";
import { MAX_NOTIFY_DELAY_MS, retryDelay, shouldNotify, type ChannelPlan } from "./dispatch.js";
import { topSignals, type Notice } from "./format.js";

const DAY = 24 * 3_600_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface RunnerOptions {
  store: Store;
  live: Live;
  notifiers: Notifier[];
  inboxUrl: string;
  log: (s: string) => void;
  now?: () => number;
  /** Tests skip the pauses between sends. */
  pause?: (ms: number) => Promise<void>;
}

export class NotifyRunner {
  private busy = false;
  private readonly now: () => number;
  private readonly pause: (ms: number) => Promise<void>;

  constructor(private o: RunnerOptions) {
    this.now = o.now ?? Date.now;
    this.pause = o.pause ?? sleep;
  }

  /** Called every few seconds. Never overlaps itself. */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.sendPosts();
      await this.sendDigestIfDue();
    } finally {
      this.busy = false;
    }
  }

  /** When a channel was first seen set up; nothing first seen before that goes to it. */
  private plan(n: Notifier): ChannelPlan {
    const key = `notify:since:${n.name}`;
    let since = Number(this.o.store.get(key));
    if (!since) {
      since = this.now();
      this.o.store.set(key, String(since));
    }
    return { groups: this.o.live.settings.notify[n.name].groups, activeSince: since };
  }

  private async sendPosts(): Promise<void> {
    const now = this.now();
    const candidates = this.o.store.notifyCandidates(now - MAX_NOTIFY_DELAY_MS);
    await Promise.all(
      this.o.notifiers.map(async (n) => {
        const plan = this.plan(n);
        for (const item of candidates) {
          if (!shouldNotify(item, plan, now)) continue;
          const prior = this.o.store.notification(item.id, n.name);
          if (prior && (prior.status === "sent" || prior.status === "failed")) continue;
          if (prior?.status === "retry" && (prior.nextAt ?? 0) > now) continue;
          const notice = this.notice(item);
          if (!notice) continue;
          const attempts = (prior?.attempts ?? 0) + 1;
          try {
            await n.send(notice, this.now());
            this.o.store.saveNotification(item.id, n.name, { status: "sent", attempts, at: this.now() });
            this.o.log(`notified ${n.name}: ${notice.group} · ${notice.tracker} · ${notice.title.slice(0, 60)}`);
          } catch (err) {
            const message = (err as Error).message;
            if (err instanceof RetryLater) {
              // Slowing down is not a failure: do not count it towards giving up.
              this.o.store.saveNotification(item.id, n.name, { status: "retry", attempts: attempts - 1, nextAt: this.now() + err.afterMs, error: message, at: this.now() });
              this.o.log(`${n.name}: ${message}, waiting ${Math.ceil(err.afterMs / 1000)} s`);
              return; // the rest of this channel waits too
            }
            const delay = retryDelay(attempts);
            this.o.store.saveNotification(item.id, n.name, {
              status: delay === null ? "failed" : "retry",
              attempts,
              nextAt: delay === null ? undefined : this.now() + delay,
              error: message,
              at: this.now(),
            });
            this.o.log(`${n.name} could not send (${message})${delay === null ? ", giving up on this post" : ", will retry"}`);
          }
          await this.pause(n.minGapMs);
        }
      }),
    );
  }

  private notice(item: ItemRow): Notice | null {
    if (!item.group) return null;
    const verdicts = this.o.store.verdictsFor(item.id).filter((v) => v.answersJson);
    const top = verdicts.find((v) => v.grp === item.grp) ?? verdicts[0];
    if (!top) return null;
    const a = (JSON.parse(top.answersJson!) as StoredAnswers).answers;
    return {
      itemId: item.id,
      group: item.group,
      tracker: top.tracker,
      phrase: top.phrase,
      kind: item.kind,
      subreddit: item.subreddit,
      author: item.author,
      title: item.title,
      createdUtc: item.createdUtc,
      threadUrl: safeUrl(item.url),
      inboxUrl: `${this.o.inboxUrl}/i/${item.id}`,
      link: item.link ? linkInfo(item.link) : null,
      score: { group: a.group.probabilities[item.group], onTopic: a.onTopic, signals: topSignals(a.signals) },
      copies: this.o.store.duplicatesOf(item.id).length,
    };
  }

  private async sendDigestIfDue(): Promise<void> {
    const store = this.o.store;
    const now = this.now();
    const last = store.get("digest:last") ?? null;
    if (last === null) {
      // First run: the first digest comes tomorrow, not seconds after install.
      store.set("digest:last", localDay(new Date(now)));
      store.set("digest:since", String(now));
      return;
    }
    const day = digestDue(new Date(now), this.o.live.settings.notify.digestAt, last);
    if (!day) return;
    store.set("digest:last", day);
    const targets = this.o.notifiers.filter((n) => this.o.live.settings.notify[n.name].digest);
    const msg = digestMessage(this.digestData(Number(store.get("digest:since")) || now - DAY, now));
    store.set("digest:since", String(now));
    store.set("digest:calls", store.get("model_calls") ?? "0");
    store.set("digest:errors", store.get("model_errors") ?? "0");
    for (const n of targets) {
      try {
        await n.sendDigest(msg);
        this.o.log(`daily digest sent to ${n.name}`);
      } catch (err) {
        this.o.log(`daily digest to ${n.name} failed: ${(err as Error).message}`);
      }
    }
  }

  digestData(since: number, now: number): DigestData {
    const store = this.o.store;
    const counter = (k: string) => Number(store.get(k) ?? 0);
    const states = new Map(store.allFeeds().map((f) => [f.url, f]));
    const feeds = buildFeeds(this.o.live.trackerList);
    return {
      since,
      now,
      counts: store.countsSince(since),
      byTracker: this.o.live.trackerList.map((t) => ({ name: t.name, counts: store.countsSince(since, t.name) })),
      unanswered: store.unansweredUrgent(now - 3 * DAY, 10).map((i) => ({
        title: i.title,
        subreddit: i.subreddit,
        threadUrl: safeUrl(i.url),
        inboxUrl: `${this.o.inboxUrl}/i/${i.id}`,
        createdUtc: i.createdUtc,
      })),
      model: { calls: counter("model_calls") - counter("digest:calls"), errors: counter("model_errors") - counter("digest:errors") },
      feedsFailing: feeds.filter((f) => {
        const s = states.get(f.url);
        return s && (s.failures > 0 || s.lastError);
      }).length,
    };
  }
}
