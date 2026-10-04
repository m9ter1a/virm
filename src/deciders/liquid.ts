// d1 from Liquid AI, through its official SDK. The SDK defaults to TypeSafe's
// own host and model, so both are always passed explicitly.
import { APIError, TypeSafeClient, type Questions } from "@typesafe-ai/sdk";
import type { RawAnswers } from "../questions.js";
import { DeciderBlockedError, type Decider } from "./types.js";

export const LIQUID_KEY_URL = "https://console.liquid.ai";

export interface LiquidOptions {
  apiKey: string;
  baseURL: string;
  model: string;
  fetch?: typeof fetch;
}

export function createLiquidDecider(o: LiquidOptions): Decider {
  const client = new TypeSafeClient({
    apiKey: o.apiKey,
    baseURL: o.baseURL,
    defaultModel: o.model,
    timeout: 30_000,
    logLevel: "off",
    fetch: o.fetch,
  });
  return {
    id: `liquid:${o.model}`,
    async decide(state, questions) {
      try {
        const r = await client.systemOne({ state: state as never, questions: questions as Questions });
        return { model: r.model, answers: r.answers as unknown as RawAnswers, usage: r.usage };
      } catch (err) {
        if (err instanceof APIError && [401, 402, 403].includes(err.status)) {
          const detail = (err.body as { error?: { message?: string } } | undefined)?.error?.message ?? err.message;
          throw new DeciderBlockedError(`Liquid API ${err.status}: ${detail}`);
        }
        throw err;
      }
    },
  };
}
