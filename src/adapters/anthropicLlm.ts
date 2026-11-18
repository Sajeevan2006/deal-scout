import type Anthropic from "@anthropic-ai/sdk";
import type { JsonRequest, LlmClient } from "../core/ports/llm";

// Optional Claude provider (LLM_PROVIDER=anthropic). Workers AI is the free default; Haiku costs
// fractions of a cent per day at Deal Scout's volume.
export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-5-5";

export interface AnthropicLlmOptions {
  apiKey: string;
  model?: string;
  // For tests
  fetch?: typeof fetch;
}

export function createAnthropicLlm(options: AnthropicLlmOptions): LlmClient {
  const model = options.model ?? DEFAULT_ANTHROPIC_MODEL;
  // Loaded on first use, so Workers AI setups never spend CPU evaluating the SDK
  let clientPromise: Promise<Anthropic> | null = null;
  function getClient(): Promise<Anthropic> {
    clientPromise ??= import("@anthropic-ai/sdk").then(
      ({ default: AnthropicClient }) =>
        new AnthropicClient({
          apiKey: options.apiKey,
          // Telegram work runs in waitUntil, which allows about 30 seconds
          timeout: 25_000,
          maxRetries: 1,
          ...(options.fetch ? { fetch: options.fetch } : {}),
        }),
    );
    return clientPromise;
  }
  return {
    name: `anthropic ${model}`,
    async generateJson(request: JsonRequest) {
      const client = await getClient();
      const response = await client.messages.create({
        model,
        // Thinking tokens count against max_tokens, so leave room above the answer itself
        max_tokens: request.maxTokens + 2048,
        system: request.system,
        messages: [{ role: "user", content: request.user }],
        output_config: {
          // Short classification and extraction work, low effort keeps it fast and cheap
          effort: "low",
          format: { type: "json_schema", schema: request.schema },
        },
      });
      if (response.stop_reason === "refusal") {
        throw new Error(`${model} declined the request`);
      }
      if (response.stop_reason === "max_tokens") {
        throw new Error(`${model} ran out of tokens before finishing the JSON`);
      }
      for (const block of response.content) {
        if (block.type === "text") {
          return JSON.parse(block.text);
        }
      }
      throw new Error(`${model} returned no text block`);
    },
  };
}
