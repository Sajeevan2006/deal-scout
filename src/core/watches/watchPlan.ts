import type { JsonSchema } from "../ports/llm";
import type { WatchPlan } from "../types";

export const MAX_LABEL_LENGTH = 60;

// What the LLM planner must return. Every field is required (structured output modes handle
// that best), so "no price limit" is 0 and "nothing to exclude" is an empty list.
export const WATCH_PLAN_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    label: {
      type: "string",
      description: "Short name shown in alerts, at most 60 characters, for example 'Portable charger'.",
    },
    intentDescription: {
      type: "string",
      description:
        "What a matching deal looks like: the product type, common synonyms, related product names, typical brands and model names. Only describe what matches, never what doesn't.",
    },
    maxPrice: {
      type: "number",
      description: "Highest acceptable price in CAD if the user gave one, otherwise 0.",
    },
    excludeTerms: {
      type: "array",
      items: { type: "string" },
      description: "Words the user explicitly ruled out, for example 'refurbished'. Empty if none.",
    },
    stores: {
      type: "array",
      items: { type: "string" },
      description:
        "Only if the user asked for specific stores, written the way RFD titles do (Amazon.ca, Costco, Best Buy). Empty otherwise.",
    },
  },
  required: ["label", "intentDescription", "maxPrice", "excludeTerms", "stores"],
  additionalProperties: false,
};

function readStringList(value: unknown, fieldName: string): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`watch plan: ${fieldName} must be a list of strings`);
  }
  const cleaned: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error(`watch plan: ${fieldName} must be a list of strings`);
    }
    const trimmed = item.trim();
    if (trimmed.length > 0 && !cleaned.includes(trimmed)) {
      cleaned.push(trimmed);
    }
  }
  return cleaned;
}

// Validates a plan, whether it came from an LLM or the rule based planner
export function parseWatchPlan(input: unknown): WatchPlan {
  if (typeof input !== "object" || input === null) {
    throw new Error("watch plan: input must be an object");
  }
  const fields = input as Record<string, unknown>;
  const label = typeof fields["label"] === "string" ? fields["label"].trim() : "";
  const intentDescription = typeof fields["intentDescription"] === "string" ? fields["intentDescription"].trim() : "";
  if (label.length === 0) {
    throw new Error("watch plan: label is required");
  }
  if (intentDescription.length === 0) {
    throw new Error("watch plan: intentDescription is required");
  }
  let maxPrice: number | null = null;
  const rawMaxPrice = fields["maxPrice"];
  if (rawMaxPrice !== undefined && rawMaxPrice !== null) {
    if (typeof rawMaxPrice !== "number" || !Number.isFinite(rawMaxPrice) || rawMaxPrice < 0) {
      throw new Error("watch plan: maxPrice must be a positive number");
    }
    // 0 means "no limit" in the LLM schema
    maxPrice = rawMaxPrice === 0 ? null : rawMaxPrice;
  }
  return {
    label: label.slice(0, MAX_LABEL_LENGTH),
    intentDescription,
    maxPrice,
    excludeTerms: readStringList(fields["excludeTerms"], "excludeTerms"),
    stores: readStringList(fields["stores"], "stores"),
  };
}
