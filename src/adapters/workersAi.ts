import type { Embedder } from "../core/ports/embedder";
import type { JsonRequest, LlmClient } from "../core/ports/llm";

// Workers AI, reachable two ways with the same models and results:
// - the env.AI binding inside the Worker
// - the REST API (account id + API token), for the local CLI and the eval

export const DEFAULT_EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
// Supports JSON mode, and fits easily in the free daily allowance at our volume
export const DEFAULT_WORKERS_AI_LLM_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export interface AiRunner {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

// The shape of env.AI that we use
export interface AiBinding {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

export function createBindingRunner(binding: AiBinding): AiRunner {
  return {
    run(model, inputs) {
      return binding.run(model, inputs);
    },
  };
}

export interface RestRunnerOptions {
  accountId: string;
  apiToken: string;
  fetchFn?: (url: string, init: RequestInit) => Promise<Response>;
}

export function createRestRunner(options: RestRunnerOptions): AiRunner {
  const fetchFn = options.fetchFn ?? ((url: string, init: RequestInit) => fetch(url, init));
  return {
    async run(model, inputs) {
      const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(options.accountId)}/ai/run/${model}`;
      const response = await fetchFn(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${options.apiToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(inputs),
      });
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new Error(`Workers AI REST ${model}: HTTP ${response.status}, body was not JSON`);
      }
      const envelope = body as { success?: boolean; result?: unknown; errors?: { message?: string }[] };
      if (!response.ok || envelope.success === false) {
        const details = (envelope.errors ?? []).map((error) => error.message ?? "").filter(Boolean).join("; ");
        throw new Error(`Workers AI REST ${model}: HTTP ${response.status}${details ? ` (${details})` : ""}`);
      }
      return envelope.result;
    },
  };
}

function readEmbeddingData(result: unknown, expected: number, model: string): number[][] {
  const data = (result as { data?: unknown } | null)?.data;
  if (!Array.isArray(data) || data.length !== expected) {
    throw new Error(`Workers AI ${model} returned ${Array.isArray(data) ? data.length : "no"} vectors for ${expected} texts`);
  }
  for (const vector of data) {
    if (!Array.isArray(vector) || vector.length === 0 || typeof vector[0] !== "number") {
      throw new Error(`Workers AI ${model} returned a vector that is not a list of numbers`);
    }
  }
  return data as number[][];
}

export function createWorkersAiEmbedder(runner: AiRunner, model = DEFAULT_EMBEDDING_MODEL, batchSize = 50): Embedder {
  return {
    model,
    async embed(texts) {
      const vectors: number[][] = [];
      for (let start = 0; start < texts.length; start += batchSize) {
        const batch = texts.slice(start, start + batchSize);
        const result = await runner.run(model, { text: batch });
        vectors.push(...readEmbeddingData(result, batch.length, model));
      }
      return vectors;
    },
  };
}

// Models sometimes wrap JSON in prose or code fences
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end <= start) {
      throw new Error(`Model reply has no JSON object: ${trimmed.slice(0, 120)}`);
    }
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

// Text generation results come back as { response } (string, or an object in JSON mode),
// and some newer models answer in the OpenAI shape { choices: [{ message: { content } }] }
export function readLlmJson(result: unknown): unknown {
  if (typeof result !== "object" || result === null) {
    throw new Error("Workers AI returned no result");
  }
  const fields = result as Record<string, unknown>;
  const response = fields["response"];
  if (typeof response === "object" && response !== null) {
    return response;
  }
  if (typeof response === "string") {
    return extractJsonObject(response);
  }
  const choices = fields["choices"];
  if (Array.isArray(choices)) {
    const content = (choices[0] as { message?: { content?: unknown } } | undefined)?.message?.content;
    if (typeof content === "string") {
      return extractJsonObject(content);
    }
  }
  throw new Error("Workers AI result has no response text");
}

export function createWorkersAiLlm(runner: AiRunner, model = DEFAULT_WORKERS_AI_LLM_MODEL): LlmClient {
  return {
    name: `workers-ai ${model}`,
    async generateJson(request: JsonRequest) {
      const result = await runner.run(model, {
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
        response_format: { type: "json_schema", json_schema: request.schema },
        max_tokens: request.maxTokens,
        temperature: 0,
      });
      return readLlmJson(result);
    },
  };
}
