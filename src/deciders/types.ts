import type { RawAnswers, SystemOneQuestions } from "../questions.js";

export interface DecideResult {
  model: string;
  answers: RawAnswers;
  usage?: { input_tokens: number; output_tokens: number };
}

/** Anything that answers System One questions about a state: d1 over the API, a local llama-server. */
export interface Decider {
  /** Stored with every verdict, e.g. "liquid:d1:free". */
  id: string;
  decide(state: Record<string, unknown>, questions: SystemOneQuestions): Promise<DecideResult>;
}

/** The decider cannot work at all until the user fixes something: a key, billing. Retrying will not help. */
export class DeciderBlockedError extends Error {}
