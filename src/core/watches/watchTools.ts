import type { WatchPlan } from "../types";

// Tool definitions for the future LLM planner. Plain JSON schema, so a provider adapter
// can map them to its own shape (input_schema / parameters).
// TODO(integration): hand these to the real LLM planner and route tool calls back here

export type JsonSchema = { [key: string]: unknown };

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export const createWatchTool: ToolDefinition = {
  name: "create_watch",
  description:
    "Create a deal watch from what the user asked for. Deals from the RedFlagDeals Hot Deals forum are matched against intentDescription by meaning, then hard filtered by maxPrice, excludeTerms and stores.",
  inputSchema: {
    type: "object",
    properties: {
      label: {
        type: "string",
        description: "Short name shown in alerts, for example 'Portable charger'.",
        maxLength: 60,
      },
      intentDescription: {
        type: "string",
        description:
          "Rich description of what counts as a match. Include the product type, common synonyms, related products, typical brands and model names, and what does not count. Example for 'portable charger': 'Portable charger, also called a power bank or battery pack, for phones and laptops. Brands like Anker, Baseus, UGREEN, INIU. Capacity in mAh. Not wall chargers or cables.'",
      },
      maxPrice: {
        type: "number",
        description: "Highest acceptable price in CAD. Only set this if the user gave a price limit.",
        minimum: 0,
      },
      excludeTerms: {
        type: "array",
        items: { type: "string" },
        description: "Words that rule a deal out, for example 'refurbished' or 'cable'.",
      },
      stores: {
        type: "array",
        items: { type: "string" },
        description: "Only alert for these stores, written the way RFD titles do, for example 'Amazon.ca', 'Costco', 'Best Buy'.",
      },
    },
    required: ["label", "intentDescription"],
    additionalProperties: false,
  },
};

export const listWatchesTool: ToolDefinition = {
  name: "list_watches",
  description: "List the user's active deal watches with their ids and labels.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
};

export const deleteWatchTool: ToolDefinition = {
  name: "delete_watch",
  description: "Stop a deal watch. Use list_watches first if you don't know the id.",
  inputSchema: {
    type: "object",
    properties: {
      watchId: { type: "integer", description: "Id of the watch to stop." },
    },
    required: ["watchId"],
    additionalProperties: false,
  },
};

export const watchTools: ToolDefinition[] = [createWatchTool, listWatchesTool, deleteWatchTool];

function readStringList(value: unknown, fieldName: string): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`create_watch: ${fieldName} must be a list of strings`);
  }
  const cleaned: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error(`create_watch: ${fieldName} must be a list of strings`);
    }
    const trimmed = item.trim();
    if (trimmed.length > 0) {
      cleaned.push(trimmed);
    }
  }
  return cleaned;
}

// Validates create_watch input, whether it came from a model tool call or the stub planner
export function parseCreateWatchInput(input: unknown): WatchPlan {
  if (typeof input !== "object" || input === null) {
    throw new Error("create_watch: input must be an object");
  }
  const fields = input as Record<string, unknown>;
  const label = typeof fields["label"] === "string" ? fields["label"].trim() : "";
  const intentDescription = typeof fields["intentDescription"] === "string" ? fields["intentDescription"].trim() : "";
  if (label.length === 0) {
    throw new Error("create_watch: label is required");
  }
  if (intentDescription.length === 0) {
    throw new Error("create_watch: intentDescription is required");
  }
  let maxPrice: number | null = null;
  const rawMaxPrice = fields["maxPrice"];
  if (rawMaxPrice !== undefined && rawMaxPrice !== null) {
    if (typeof rawMaxPrice !== "number" || !Number.isFinite(rawMaxPrice) || rawMaxPrice < 0) {
      throw new Error("create_watch: maxPrice must be a positive number");
    }
    maxPrice = rawMaxPrice;
  }
  return {
    label: label.slice(0, 60),
    intentDescription,
    maxPrice,
    excludeTerms: readStringList(fields["excludeTerms"], "excludeTerms"),
    stores: readStringList(fields["stores"], "stores"),
  };
}
