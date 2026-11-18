import type { BorderlineJudge } from "../ports/borderlineJudge";
import type { JsonSchema, LlmClient } from "../ports/llm";
import type { Post, Watch } from "../types";
import { extractStore, pickLikelyPrice } from "./postText";

export const JUDGE_SYSTEM_PROMPT = `You check deal posts from the RedFlagDeals Hot Deals forum against what a user is watching for.
Answer match=true only if the post is a deal on the kind of product the user wants. Related accessories, different product categories, or posts that only share a word (an "EV charger" program is not a phone charger) are not a match.
Reply with JSON only.`;

const JUDGE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    match: { type: "boolean", description: "True if this post is a deal the user wants to hear about." },
  },
  required: ["match"],
  additionalProperties: false,
};

export interface LlmJudgeOptions {
  bodyChars?: number;
}

export function buildJudgePrompt(post: Post, watch: Watch, bodyChars: number): string {
  const lines = [`Watching for: ${watch.label}`, `Description: ${watch.intentDescription}`];
  if (watch.maxPrice !== null) {
    lines.push(`Price limit: $${watch.maxPrice}`);
  }
  lines.push("", `Post title: ${post.title}`);
  const store = extractStore(post.title);
  const price = pickLikelyPrice(post.title);
  if (store !== null) {
    lines.push(`Store: ${store}`);
  }
  if (price !== null) {
    lines.push(`Price: $${price}`);
  }
  const bodyStart = post.bodyText.slice(0, bodyChars).trim();
  if (bodyStart.length > 0) {
    lines.push(`Post text: ${bodyStart}`);
  }
  return lines.join("\n");
}

// Throws when the answer can't be read; the matcher treats that as "no" and counts it
export function createLlmJudge(llm: LlmClient, options: LlmJudgeOptions = {}): BorderlineJudge {
  const bodyChars = options.bodyChars ?? 300;
  return {
    async isMatch(post, watch) {
      const raw = await llm.generateJson({
        system: JUDGE_SYSTEM_PROMPT,
        user: buildJudgePrompt(post, watch, bodyChars),
        schema: JUDGE_SCHEMA,
        maxTokens: 50,
      });
      if (typeof raw !== "object" || raw === null || typeof (raw as Record<string, unknown>)["match"] !== "boolean") {
        throw new Error(`Judge (${llm.name}) gave an answer without a boolean "match"`);
      }
      return (raw as { match: boolean }).match;
    },
  };
}
