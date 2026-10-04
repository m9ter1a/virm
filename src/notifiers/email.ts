// Email over SMTP. SMTP_URL holds the server and the login, e.g.
// smtps://me%40gmail.com:app-password@smtp.gmail.com:465
import nodemailer from "nodemailer";
import { plainText, title, type Notice } from "../notify/format.js";
import { ICON } from "../notify/format.js";
import { GROUP_LABEL } from "../types.js";
import type { Notifier } from "./types.js";

export interface EmailOptions {
  smtpUrl: string;
  to: string;
  from?: string;
}

export function createEmailNotifier(o: EmailOptions): Notifier {
  const transport = nodemailer.createTransport(o.smtpUrl);
  const from = o.from || fromAddress(o.smtpUrl) || o.to;
  return {
    name: "email",
    minGapMs: 2_000,
    async send(n: Notice, now: number) {
      await transport.sendMail({
        from: `virm <${from}>`,
        to: o.to,
        subject: `${ICON[n.group]} ${GROUP_LABEL[n.group]}: ${title(n).slice(0, 150)}`,
        text: plainText(n, now),
      });
    },
    async sendDigest(d) {
      await transport.sendMail({ from: `virm <${from}>`, to: o.to, subject: d.subject, text: d.text });
    },
  };
}

/** The login of smtp(s)://user:pass@host, when it is an address. */
function fromAddress(url: string): string | null {
  try {
    const user = decodeURIComponent(new URL(url).username);
    return user.includes("@") ? user : null;
  } catch {
    return null;
  }
}
