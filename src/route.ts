// Pure: the model's probabilities + the item's age + thresholds → one group.
// The model never picks the group directly. "When in doubt, demote" is a
// threshold here, not a request in a prompt.
import { HARD_URGENT_MAX_AGE_HOURS, type Thresholds } from "./config.js";
import type { Answers, GroupId } from "./types.js";

export interface Routed {
  group: GroupId;
  /** Why, when the code overrode the model's best choice. */
  reason: string | null;
}

export function route(a: Answers, ageHours: number, urgentWithinHours: number, t: Thresholds): Routed {
  if (a.spam >= t.spam) return { group: "noise", reason: `spam ${a.spam.toFixed(2)}` };
  // Whatever the group says. The group question files "not noise, not
  // relevant" under FYI: on the first 410 real posts (2026-10-04), letting FYI
  // through when off topic kept 43 posts, nearly all junk, to rescue one.
  if (a.onTopic <= t.offTopic) return { group: "noise", reason: `off topic ${a.onTopic.toFixed(2)}` };

  const best = a.group.choice;
  const pUrgent = a.group.probabilities.urgent;
  const tooOld = ageHours > Math.min(urgentWithinHours, HARD_URGENT_MAX_AGE_HOURS);
  // Urgent interrupts a person, so it also needs the post to be clearly on
  // the subject: on the same data, false Urgents had on topic 0.35–0.41,
  // real ones 0.72 and up.
  const surelyOnTopic = a.onTopic >= t.urgentOnTopic;
  if (pUrgent >= t.urgent && !tooOld && surelyOnTopic) return { group: "urgent", reason: null };

  if (best !== "urgent") return { group: best, reason: null };
  if (tooOld) return { group: "worth", reason: `too old for urgent (${Math.round(ageHours)} h)` };
  if (!surelyOnTopic) return { group: "worth", reason: `on topic ${a.onTopic.toFixed(2)} below ${t.urgentOnTopic} for urgent` };
  return { group: "worth", reason: `urgent ${pUrgent.toFixed(2)} below ${t.urgent}` };
}
