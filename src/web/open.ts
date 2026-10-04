// Open a URL in the user's default browser. Best effort: if it fails, the URL
// is printed or shown anyway.
import { spawn } from "node:child_process";

/**
 * Only the inbox and Reddit threads, and only characters that mean nothing to
 * a shell: on Windows the URL goes through `cmd /c start`, where "&" or "|"
 * would start another command.
 */
const SAFE = /^(http:\/\/127\.0\.0\.1:\d+|https:\/\/(www\.|old\.)?reddit\.com)(\/[A-Za-z0-9_\-./%~]*)?$/;

export function openUrl(url: string): void {
  if (!SAFE.test(url)) return;
  const [cmd, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", '""', url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    // Verbatim on Windows: cmd must see start "" <url> unquoted. The URL was checked above.
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // No browser available: the URL is in the log.
  }
}

/** @deprecated name kept for the CLI; same as openUrl. */
export const openBrowser = openUrl;
