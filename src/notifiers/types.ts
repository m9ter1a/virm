import type { ChannelName } from "../config.js";
import type { DigestMessage } from "../notify/digest.js";
import type { Notice } from "../notify/format.js";

/** Calls the user somewhere. Work happens in the inbox; a notifier only points at it. */
export interface Notifier {
  name: ChannelName;
  /** Least time between two sends, to stay inside the service's rate limit. */
  minGapMs: number;
  send(n: Notice, now: number): Promise<void>;
  sendDigest(d: DigestMessage): Promise<void>;
}

/** The service asked us to slow down: try again after this long. */
export class RetryLater extends Error {
  constructor(
    readonly afterMs: number,
    message: string,
  ) {
    super(message);
  }
}

/** POST JSON; turn a 429 into RetryLater and any other non-2xx into an error with the service's own words. */
export async function postJson(
  doFetch: typeof fetch,
  url: string,
  body: unknown,
  retryAfterMs: (res: Response, text: string) => number,
): Promise<void> {
  const res = await doFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.ok) return;
  const text = await res.text().catch(() => "");
  if (res.status === 429) throw new RetryLater(retryAfterMs(res, text), `rate limited (HTTP 429)`);
  throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
}

/** Retry-After in seconds, as Slack and most services send it. */
export const retryAfterHeader = (res: Response) => {
  const s = Number(res.headers.get("retry-after"));
  return Number.isFinite(s) && s > 0 ? s * 1000 : 30_000;
};
