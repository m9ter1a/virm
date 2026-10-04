// Which notifiers exist: a channel is on when it is enabled in config.json and
// its secret is in the environment. Desktop needs no secret.
import type { ChannelName, Settings } from "../config.js";
import { createDesktopNotifier } from "../notifiers/desktop.js";
import { createDiscordNotifier } from "../notifiers/discord.js";
import { createEmailNotifier } from "../notifiers/email.js";
import { createSlackNotifier } from "../notifiers/slack.js";
import type { Notifier } from "../notifiers/types.js";
import { createWebhookNotifier } from "../notifiers/webhook.js";

export const SECRETS: Record<Exclude<ChannelName, "desktop">, string[]> = {
  slack: ["SLACK_WEBHOOK_URL"],
  discord: ["DISCORD_WEBHOOK_URL"],
  webhook: ["VIRM_WEBHOOK_URL"],
  email: ["SMTP_URL", "EMAIL_TO"],
};

export interface ChannelStatus {
  name: ChannelName;
  on: boolean;
  /** Why it is off, in words a user can act on. */
  why?: string;
}

const isUrl = (s: string, https: boolean) => {
  try {
    const u = new URL(s);
    return https ? u.protocol === "https:" : u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
};

export function buildNotifiers(settings: Settings, env: NodeJS.ProcessEnv = process.env): { notifiers: Notifier[]; status: ChannelStatus[] } {
  const notifiers: Notifier[] = [];
  const status: ChannelStatus[] = [];
  const add = (name: ChannelName, make: () => Notifier | string) => {
    if (!settings.notify[name].enabled) return status.push({ name, on: false, why: "disabled in config.json" });
    const missing = name === "desktop" ? [] : SECRETS[name].filter((k) => !env[k]?.trim());
    if (missing.length) return status.push({ name, on: false, why: `set ${missing.join(" and ")} in .env` });
    const made = make();
    if (typeof made === "string") return status.push({ name, on: false, why: made });
    notifiers.push(made);
    status.push({ name, on: true });
  };
  add("desktop", () => createDesktopNotifier());
  add("slack", () => (isUrl(env.SLACK_WEBHOOK_URL!, true) ? createSlackNotifier(env.SLACK_WEBHOOK_URL!.trim()) : "SLACK_WEBHOOK_URL is not an https URL"));
  add("discord", () =>
    isUrl(env.DISCORD_WEBHOOK_URL!, true) ? createDiscordNotifier(env.DISCORD_WEBHOOK_URL!.trim()) : "DISCORD_WEBHOOK_URL is not an https URL",
  );
  add("webhook", () => (isUrl(env.VIRM_WEBHOOK_URL!, false) ? createWebhookNotifier(env.VIRM_WEBHOOK_URL!.trim()) : "VIRM_WEBHOOK_URL is not a URL"));
  add("email", () => createEmailNotifier({ smtpUrl: env.SMTP_URL!.trim(), to: env.EMAIL_TO!.trim(), from: env.EMAIL_FROM?.trim() }));
  return { notifiers, status };
}
