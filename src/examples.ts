// One example tracker per template. `virm init` writes these when there is no
// trackers.json yet, so a new user sees a working file to edit, not a blank one.
import type { TrackerInput } from "./config.js";

export const EXAMPLE_TRACKERS: TrackerInput[] = [
  {
    name: "freshclone",
    template: "help",
    about:
      "I maintain freshclone, a CLI that checks whether a repo builds on someone else's clean machine. I want to help people whose project works locally but fails for others, in CI or after a fresh clone.",
    queries: ['"works on my machine"', '"fails on CI"', '"builds locally"', '"works locally" CI', 'lockfile "npm ci"'],
    commentSubreddits: ["node", "javascript", "webdev"],
    excludeSubreddits: ["ProgrammerHumor"],
  },
  {
    name: "Node.js news",
    template: "news",
    about:
      "I follow Node.js. Most of all I want to know about new releases, security fixes and breaking changes.",
    queries: ['"Node.js" release', '"Node 24"', '"Node 26"', "nodejs security"],
  },
  {
    name: "Bun",
    template: "mentions",
    about:
      "I work on Bun, the JavaScript runtime and toolkit. I want to see what people say about it, especially bugs and complaints.",
    queries: ["bunjs", '"bun install"', '"bun runtime"', "Bun javascript", "Bun node"],
  },
  {
    name: "API client leads",
    template: "competitors",
    about:
      "I make an open-source API client, an alternative to Postman and Insomnia. I want to find people looking for one or unhappy with theirs.",
    queries: ['"Postman alternative"', '"alternative to Postman"', '"Insomnia alternative"', "Postman pricing"],
  },
];
