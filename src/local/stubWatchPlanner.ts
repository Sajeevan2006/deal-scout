import type { WatchPlanner } from "../core/ports/watchPlanner";
import type { WatchPlan } from "../core/types";

// PLACEHOLDER planner: simple rules instead of an LLM. It can't add synonyms or related
// products to intentDescription, which is the main thing the real planner is for.
// TODO(integration): replace with the LLM planner that calls the create_watch tool

const MAX_LABEL_LENGTH = 60;
const PRICE_PHRASE =
  /(?:\b(?:under|below|less than|max(?:imum)?|up to|at most|no more than)\s*)?\$\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)(?:\s*(?:or less|max))?/i;
const EXCLUDE_PHRASE = /\b(?:no|not|without|excluding|except)\s+([^,.;]+)/gi;
const TERM_SEPARATOR = /\s*(?:,|\bor\b|\band\b|\bnor\b)\s*/i;

function cleanUpText(text: string): string {
  const collapsedSpaces = text.replace(/\s+/g, " ");
  const collapsedCommas = collapsedSpaces.replace(/\s*,\s*(?:,\s*)*/g, ", ");
  return collapsedCommas.replace(/^[\s,.;:-]+|[\s,.;:-]+$/g, "");
}

export function planWatchWithRules(userRequest: string): WatchPlan {
  let remainingText = userRequest;

  let maxPrice: number | null = null;
  const priceMatch = PRICE_PHRASE.exec(remainingText);
  if (priceMatch && priceMatch[1] !== undefined) {
    maxPrice = Number(priceMatch[1].replace(/,/g, ""));
    remainingText = remainingText.replace(priceMatch[0], " ");
  }

  const excludeTerms: string[] = [];
  for (const excludeMatch of remainingText.matchAll(EXCLUDE_PHRASE)) {
    const phrase = excludeMatch[1] ?? "";
    for (const rawTerm of phrase.split(TERM_SEPARATOR)) {
      const term = rawTerm.trim().toLowerCase();
      if (term.length > 0 && !excludeTerms.includes(term)) {
        excludeTerms.push(term);
      }
    }
  }
  remainingText = remainingText.replace(EXCLUDE_PHRASE, " ");

  let intentDescription = cleanUpText(remainingText);
  if (intentDescription.length === 0) {
    intentDescription = cleanUpText(userRequest);
  }
  const label = intentDescription.slice(0, MAX_LABEL_LENGTH);

  return { label, intentDescription, maxPrice, excludeTerms, stores: [] };
}

export function createStubWatchPlanner(): WatchPlanner {
  return {
    async planWatch(userRequest) {
      return planWatchWithRules(userRequest);
    },
  };
}
