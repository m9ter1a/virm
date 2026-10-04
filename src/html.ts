// Pure: Reddit's entry HTML → plain text. Text from Reddit is untrusted input;
// nothing downstream ever renders it as HTML, and this strips markup anyway.

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    return NAMED[code.toLowerCase()] ?? whole;
  });
}

/**
 * Reddit wraps the body of a post or comment in <!-- SC_OFF -->…<!-- SC_ON -->.
 * Everything outside it is chrome: the thumbnail table of a link post and the
 * "submitted by … [link] [comments]" footer. No markers means no body.
 */
export function htmlToText(html: string): string {
  const m = html.match(/<!-- SC_OFF -->([\s\S]*?)<!-- SC_ON -->/);
  if (!m) return "";
  const text = m[1]
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    // A blank line between blocks, so paragraphs stay paragraphs in the inbox.
    .replace(/<\/(p|h[1-6]|pre|blockquote|table|ul|ol)>/gi, "\n\n")
    .replace(/<\/(div|li|tr)>/gi, "\n")
    .replace(/<[^>]*>/g, " ");
  return decodeEntities(text)
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
