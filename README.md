# virm

**Watch Reddit for what you care about, and only get called when it matters.**

virm searches Reddit for your topics, and a decision model sorts every post it finds into **Urgent**, **Worth a look**, **FYI** or **Noise**. Everything lands in an inbox in your browser. Only Urgent interrupts you, with a desktop notification or a message in Slack, Discord, email or any webhook. Noise never does. You always reply on Reddit yourself.

```bash
npx virm init
npx virm start
```

![The virm inbox: a list of posts on the left, the selected post and why it was sorted that way on the right](docs/inbox.jpg)

It runs on your computer. The only account it needs is a free API key from [Liquid AI](https://console.liquid.ai) for the decision model.

## How it works

1. **You describe a tracker**: what to search for, and in a sentence or two, why you care. For example: *"I maintain a CLI that checks whether a repo builds on a clean machine. I want to help people whose project works locally but fails in CI."*
2. **virm collects.** Once a minute it reads one of Reddit's public RSS feeds: search results for your phrases, new comments in subreddits you pick, or every new post in a subreddit. No Reddit account or key is needed.
3. **Rules first.** Duplicates, your own posts, blocked subreddits and bots are settled by plain code, without the model. A post shared to several subreddits is shown once.
4. **The model judges.** [d1](https://www.liquid.ai) is a *decision model*: it does not write text, it answers questions with probabilities. virm asks it which group the post belongs to for *your* goal, whether it is really about your subject or just shares a word, and whether it is spam.
5. **The code decides.** The group is picked by thresholds on those probabilities, not by the model directly. When in doubt it demotes: a needless alert costs more than a missed one.
6. **You work in the inbox**, and every correction you make is saved. Once you have corrected enough posts of a tracker, its Urgent threshold follows your choices.

## Install

You need [Node.js](https://nodejs.org) 22.13 or newer.

```bash
npx virm init
```

`init` asks for your Liquid key (input hidden), checks it with one real call, and saves it. To get a key: sign up at [console.liquid.ai](https://console.liquid.ai), open **API keys**, create one. Then it helps you write your first tracker.

```bash
npx virm start
```

This starts collecting and opens the inbox at `http://127.0.0.1:4545`. Leave it running. `npx virm doctor` checks everything if something looks off.

## Trackers

A tracker is one thing you want to hear about. Pick a goal, and the meaning of the four groups follows from it:

| Goal | Urgent means |
|---|---|
| **Help people** | Someone asks for help or a recommendation in your area, or reports a problem squarely in it |
| **Follow news** | A release, an outage, a pricing or policy change: something to know today |
| **Mentions of my product** | A complaint, a bug report, a question to the makers |
| **Competitors and alternatives** | Someone is looking for a tool like yours right now |
| **Custom** | Whatever you write |

Add and edit trackers on the **Trackers** page of the inbox. They live in `trackers.json` in virm's data folder (`npx virm paths` shows where), which you can also edit by hand; virm picks up changes within a minute.

```json
{
  "name": "my-cli",
  "template": "help",
  "about": "I maintain my-cli, a tool that checks whether a repo builds on a clean machine. I want to help people whose project works locally but fails for others or in CI.",
  "queries": ["\"works on my machine\"", "\"fails on CI\"", "lockfile \"npm ci\""],
  "commentSubreddits": ["node", "javascript"],
  "excludeSubreddits": ["ProgrammerHumor"]
}
```

- **`about` matters most.** The model judges every post against it. Name the subject broadly first, then what matters most. "I follow Rust; most of all I want compiler releases" works better than "I want compiler releases", which makes every other Rust post look off topic.
- **`queries`** go to Reddit's search, which finds posts, not comments. Quotes make an exact phrase. Reddit's search is loose (it also matches word forms and text in images), so expect noise: sorting it out is the model's job.
- **`commentSubreddits`**: new comments there are checked for your phrases.
- **`subreddits`**: every new post there, no phrase needed.
- Optional: `groups` to rewrite what a group means, `urgentWithinHours`, `thresholds`, `paused`.

## The inbox

| Key | |
|---|---|
| `J` `K` | next / previous post |
| `O` | open the thread on Reddit |
| `R` / `S` | replied / skip: done with it |
| `1` `2` `3` `4` | put the post in Urgent, Worth a look, FYI, Noise |
| `U` | undo |
| `[` `]` | previous / next group |

Shortcuts work in any keyboard layout. Moving a post to another group asks first (press the same key again, or turn the question off). Under every post, **Why it is here** shows which phrase matched, every probability the model gave, and the thresholds as marks on the bars.

## Thresholds

The model gives probabilities; thresholds turn them into groups. A post is Urgent only if the model is confident enough, it is clearly on your subject, and it is fresh (6 to 24 hours depending on the goal; never older than 48).

- **Drag a threshold mark** under any post to change it for that tracker. The groups are recomputed at once from stored answers, with no new model calls.
- **Or let it learn.** After 20 labelled posts of a tracker (at least 3 Urgent and 3 not), its Urgent threshold follows your labels: one small step at a time, between 0.5 and 0.95, never past what you set by hand. Turn it off with `"learnThresholds": false` in `config.json`.
- Global defaults are in `config.json`; a tracker's own `thresholds` win over them.

## Notifications

Only posts that are new, Urgent (by default) and not a cross-post notify. Nothing from the first fetch of a feed does, so a new tracker does not flood you with old posts.

| Channel | Setup |
|---|---|
| Desktop | nothing: on by default. Clicking it opens the thread |
| Slack | `SLACK_WEBHOOK_URL` (an incoming webhook) |
| Discord | `DISCORD_WEBHOOK_URL` |
| Email | `SMTP_URL` (e.g. `smtps://me%40gmail.com:app-password@smtp.gmail.com:465`) and `EMAIL_TO` |
| Webhook | `VIRM_WEBHOOK_URL`: a JSON POST for n8n, Zapier, a Telegram bot, your own code |

Secrets go in `.env` in the data folder. Which groups each channel gets, and whether it gets the daily digest, is set in `config.json`:

```json
"notify": {
  "slack": { "groups": ["urgent", "worth"] },
  "desktop": { "enabled": false },
  "digestAt": "09:00"
}
```

The daily digest lists unanswered Urgent posts, counts per group and tracker, and model and feed health. Check every channel with `npx virm doctor --notify`.

## Keep it running

virm works only while your computer is on and `virm start` is running. To start it with your computer:

- **Windows**: `schtasks /create /tn virm /tr "npx virm start --no-open" /sc onlogon`
- **macOS**: a launchd agent in `~/Library/LaunchAgents/` running `npx virm start --no-open` with `RunAtLoad`.
- **Linux**: a systemd user unit with `ExecStart=npx virm start --no-open`, then `systemctl --user enable --now virm`.

On a server, the inbox still listens on 127.0.0.1 only: reach it through an SSH tunnel, and use Slack, Discord or email instead of desktop notifications.

## Commands

| | |
|---|---|
| `virm init` | set up the key and a first tracker |
| `virm start` | collect, sort, notify, serve the inbox |
| `virm inbox` | only the inbox, no collecting |
| `virm doctor [--notify]` | check the setup; send test notifications |
| `virm list`, `virm feeds` | the inbox and feed status in the terminal |
| `virm try <tracker> "<text>"` | see how a tracker would sort a piece of text |
| `virm reroute` | re-apply thresholds to everything stored |
| `virm templates`, `virm paths` | the goals' texts; where the files are |

## Privacy and limits

- **Everything stays on your computer**: posts, labels, settings. Nothing is sent anywhere except Reddit (to read feeds) and Liquid AI (each post's title and text, and your tracker's `about`, to classify it).
- **One Reddit request per minute.** That is Reddit's limit for RSS per IP. With many trackers each feed is read less often; the Feeds dialog in the inbox shows how often.
- **RSS is not an official API.** Reddit could change or close it. virm reads it politely: one request a minute, a real User-Agent, no proxies, no tricks. If it closes, virm will move to another legal path, not around a block.
- **Comments** are found only in the subreddits you list: Reddit's search does not search comments.
- **d1 is free during Liquid's experimental phase.** Each post takes about 2,700 input tokens. At $0.04 per million (the price listed for d1 on Vercel AI Gateway), a busy tracker of about 500 posts a day would cost around $20 a year; a quiet one, cents.
- virm never posts, comments or votes on Reddit. You reply yourself.

## License

MIT
