import type { LlmClient } from "../ports/llm";
import type { WatchPlanner } from "../ports/watchPlanner";
import type { Logger, WatchPlan } from "../types";
import { planWatchWithRules } from "./rulePlanner";
import { parseWatchPlan, WATCH_PLAN_SCHEMA } from "./watchPlan";

export const PLANNER_SYSTEM_PROMPT = `You set up deal alerts for the RedFlagDeals Hot Deals forum, a Canadian deals forum.
Post titles look like "[Amazon.ca] Anker 20000mAh Power Bank $29.99" or "[Costco] Ninja Air Fryer $99.99".

Turn the user's request into a watch:
- label: a short name for alerts, at most 60 characters.
- intentDescription: one paragraph describing what a matching deal looks like. Include the product type, common synonyms, related product names, typical brands and model names, and words a deal title would use. It is compared by meaning against post titles, so describe only what matches. Never mention what to avoid here, because mentioning it makes those posts look more similar.
- maxPrice: the price limit in CAD if the user gave one, otherwise 0.
- excludeTerms: only words the user explicitly ruled out (for example "no refurbished" gives "refurbished"). Empty list otherwise.
- stores: only stores the user explicitly asked for, written the way RFD titles write them. Empty list otherwise.

Reply with JSON only.`;

export interface LlmWatchPlannerOptions {
  logger?: Logger;
}

// LLM planner with two safety nets: if the call fails or returns junk, the rule planner takes
// over, and the rule planner's explicit price and "no X" terms are always kept, since the
// rules read those reliably and a model can drop them.
export function createLlmWatchPlanner(llm: LlmClient, options: LlmWatchPlannerOptions = {}): WatchPlanner {
  return {
    async planWatch(userRequest) {
      const rulePlan = planWatchWithRules(userRequest);
      let llmPlan: WatchPlan;
      try {
        const raw = await llm.generateJson({
          system: PLANNER_SYSTEM_PROMPT,
          user: `Request: ${userRequest}`,
          schema: WATCH_PLAN_SCHEMA,
          maxTokens: 800,
        });
        llmPlan = parseWatchPlan(raw);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.logger?.warn(`Watch planner (${llm.name}) failed, using the rule planner instead: ${message}`);
        return rulePlan;
      }
      const excludeTerms = [...llmPlan.excludeTerms];
      for (const term of rulePlan.excludeTerms) {
        if (!excludeTerms.some((existing) => existing.toLowerCase() === term.toLowerCase())) {
          excludeTerms.push(term);
        }
      }
      return {
        ...llmPlan,
        maxPrice: rulePlan.maxPrice ?? llmPlan.maxPrice,
        excludeTerms,
      };
    },
  };
}
