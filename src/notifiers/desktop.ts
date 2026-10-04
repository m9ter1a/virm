// The operating system's own notification: works with no setup at all.
// Clicking it opens the thread.
import notifier from "toasted-notifier";
import { GROUP_LABEL } from "../types.js";
import { ICON, title, type Notice } from "../notify/format.js";
import { openUrl } from "../web/open.js";
import type { Notifier } from "./types.js";

type Notify = (options: Record<string, unknown>, callback: (err: Error | null, response?: unknown) => void) => void;

/** A click arrives as "activate" on Windows, "activate"/"click" elsewhere. */
const isClick = (response: unknown) => /^(activate|click|clicked)$/i.test(String(response ?? "").trim());

export function createDesktopNotifier(notify: Notify = notifier.notify.bind(notifier) as Notify, open: (url: string) => void = openUrl): Notifier {
  const show = (titleText: string, message: string, target: string) =>
    new Promise<void>((resolve, reject) => {
      let settled = false;
      notify({ title: titleText, message, appID: "virm", wait: true, timeout: 30 }, (err, response) => {
        if (isClick(response) && target) open(target);
        // The callback fires when the toast closes, which can be much later; the send is done once it is shown.
        // A toast closed (or clicked) within the first second settles the send here.
        if (!settled) {
          settled = true;
          if (err) reject(err);
          else resolve();
        }
      });
      setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve();
        }
      }, 1_000);
    });
  return {
    name: "desktop",
    minGapMs: 1_500,
    send: (n: Notice) =>
      show(`${ICON[n.group]} ${GROUP_LABEL[n.group]} · r/${n.subreddit} · ${n.tracker}`, title(n), n.threadUrl || n.inboxUrl),
    sendDigest: (d) => show("virm daily", d.short, ""),
  };
}
