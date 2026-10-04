// Shared shapes. Nothing here does I/O.

export const GROUPS = ["urgent", "worth", "fyi", "noise"] as const;
export type GroupId = (typeof GROUPS)[number];

/** Higher wins when one item is classified for several trackers. */
export const GROUP_RANK: Record<GroupId, number> = { urgent: 3, worth: 2, fyi: 1, noise: 0 };

export const GROUP_LABEL: Record<GroupId, string> = {
  urgent: "Urgent",
  worth: "Worth a look",
  fyi: "FYI",
  noise: "Noise",
};

/** A Reddit post or comment, normalized from an Atom entry. */
export interface Item {
  /** Reddit fullname: t3_… for a post, t1_… for a comment. The dedup key. */
  id: string;
  kind: "post" | "comment";
  subreddit: string;
  /** Without the /u/ prefix. */
  author: string;
  /** The post title; for a comment, the title of its thread. */
  title: string;
  /** Plain text, never HTML. */
  text: string;
  url: string;
  /** What a post links to when it is not a text post: an article, image, video. Null for text posts and comments. */
  link: string | null;
  /** Milliseconds since the epoch. */
  createdUtc: number;
}

/** What the decision model said, reduced to what the router needs. */
export interface Answers {
  group: {
    choice: GroupId;
    confidence: number;
    probabilities: Record<GroupId, number>;
  };
  /** P(the post is really about the tracker's topic). */
  onTopic: number;
  /** P(spam, an ad or a bot). */
  spam: number;
  /** P(yes) for each extra yes/no question of the tracker. */
  signals: Record<string, number>;
}
