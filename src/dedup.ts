// Pure: the same post shared to several subreddits. On 2026-10-04 one news
// story reached the Urgent tab five times in an hour, from five subreddits,
// with the same title. Copies are kept and classified, but shown and
// notified once, on the first one seen.

/** Window in which an equal title counts as a copy. */
export const DUPLICATE_WINDOW_MS = 48 * 3_600_000;

/**
 * Titles this short are too generic to mean "the same post": "Help",
 * "Question about CI", "Weekly thread".
 */
const MIN_KEY_LENGTH = 24;

/** Lower case, letters and digits only, single spaces. Null when too short to trust. */
export function titleKey(title: string): string | null {
  const key = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return key.length >= MIN_KEY_LENGTH ? key : null;
}
