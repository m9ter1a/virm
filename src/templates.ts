// Tracker templates. A template is a set of default group definitions for one
// kind of goal. The definitions are plain text that goes to the decision
// model, so any goal is just different text: a tracker picks a template and
// may override any definition with its own words.
import type { GroupId } from "./types.js";

export const TEMPLATE_IDS = ["help", "news", "mentions", "competitors", "custom"] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

export interface Template {
  id: TemplateId;
  title: string;
  summary: string;
  /** Shown when asking the user to describe the tracker. */
  aboutExample: string;
  groups: Record<GroupId, string>;
  /** Extra yes/no questions. Their answers are stored and shown, not routed on. */
  signals: Record<string, string>;
  /** A post older than this cannot be Urgent for this kind of tracker. */
  urgentWithinHours: number;
}

const NOISE =
  "Unrelated to the topic: the keyword in another meaning, a meme or joke, an off-topic rant, spam, self-promotion or NSFW.";

export const TEMPLATES: Record<TemplateId, Template> = {
  help: {
    id: "help",
    title: "Help people",
    summary: "Find people asking for help in an area you know, or with a problem your tool solves.",
    aboutExample:
      "I maintain freshclone, a CLI that checks whether a repo builds on someone else's clean machine. I want to help people whose project works locally but fails for others or in CI.",
    groups: {
      urgent:
        "The author directly asks for help, advice or a tool recommendation on this topic, or reports a problem squarely in it, and a knowledgeable reply would clearly help them.",
      worth:
        "A discussion on this topic where a knowledgeable person has something useful to add, but nobody is waiting for an answer.",
      fyi: "On topic, but a reply would add nothing: news, a showcase, a question that is already well answered, or a passing mention.",
      noise: NOISE,
    },
    signals: {
      asks_help: "Is the author asking for help, advice or a tool recommendation?",
      has_problem: "Does the author describe a problem, error or failure they have right now?",
    },
    urgentWithinHours: 6,
  },
  news: {
    id: "news",
    title: "Follow news",
    summary: "Stay on top of a product, company, person or topic without reading everything about it.",
    // Name the subject broadly first, then what matters most. An about that
    // lists only releases made d1 call opinions about the subject off topic.
    aboutExample:
      "I follow Node.js. Most of all I want to know about new releases, security fixes and breaking changes.",
    groups: {
      urgent:
        "Major news on this topic: a release or launch, an outage or incident, a pricing, limits or policy change, a security issue, an acquisition. Something to know today.",
      worth:
        "Substantive discussion worth reading: a detailed review, benchmark, comparison, tutorial or first-hand experience report.",
      fyi: "A passing mention, a low-effort question, an opinion without new information, or a repost of news already covered.",
      noise: NOISE,
    },
    signals: {
      announcement:
        "Does the post report new, official or first-hand news (a release, launch, incident or change) rather than opinion?",
      substantive: "Does the post contain substantial original content, such as a review, benchmark or detailed experience?",
    },
    urgentWithinHours: 12,
  },
  mentions: {
    id: "mentions",
    title: "Mentions of my product",
    summary: "Catch people talking about your product, project or brand, especially when something is wrong.",
    aboutExample: "I make Acme Notes, a note-taking app for iOS and Android. I want to see what people say about it.",
    groups: {
      urgent:
        "A complaint, bug report, outage report or harsh criticism of the product, or a question addressed to its makers: something they should answer quickly.",
      worth:
        "A review, comparison, recommendation or usage question about the product, where its makers could usefully join in.",
      fyi: "A passing mention or a link in a list, where joining in would add nothing.",
      noise: "The name refers to something else (a namesake), or the post is spam, a meme or NSFW.",
    },
    signals: {
      complaint: "Does the post contain a complaint, a bug report or criticism of the product?",
      question: "Does the post ask how to use the product or whether it can do something?",
    },
    urgentWithinHours: 12,
  },
  competitors: {
    id: "competitors",
    title: "Competitors and alternatives",
    summary: "Find people looking for a tool like yours, or unhappy with the one they use.",
    aboutExample:
      "I make an open-source API client, an alternative to Postman and Insomnia. I want to find people looking for one or unhappy with theirs.",
    groups: {
      urgent:
        "The author is actively looking for a tool or service like this, asks for alternatives to a competitor, or is about to choose one: a recommendation would be welcome now.",
      worth:
        "A comparison or discussion of tools in this space, or a complaint about a competitor, where an informed view would be useful.",
      fyi: "News or announcements about competitors, or a passing mention.",
      noise: NOISE,
    },
    signals: {
      seeks_tool: "Is the author looking for a tool, service or alternative?",
      dissatisfied: "Is the author unhappy with a tool or service they currently use?",
    },
    urgentWithinHours: 24,
  },
  custom: {
    id: "custom",
    title: "Custom",
    summary: "Anything else. Write the group definitions yourself; these are only neutral fallbacks.",
    aboutExample: "Describe what you watch for and why, in a sentence or two.",
    groups: {
      urgent: "Needs this person's attention within hours.",
      worth: "Worth a look today or tomorrow.",
      fyi: "Good to know, no action needed.",
      noise: NOISE,
    },
    signals: {},
    urgentWithinHours: 12,
  },
};
