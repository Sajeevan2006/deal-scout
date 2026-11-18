import { describe, expect, it } from "vitest";
import { createAnthropicLlm } from "../src/adapters/anthropicLlm";
import {
  createRestRunner,
  createWorkersAiEmbedder,
  createWorkersAiLlm,
  extractJsonObject,
  readLlmJson,
  type AiRunner,
} from "../src/adapters/workersAi";
import { buildJudgePrompt, createLlmJudge } from "../src/core/matching/llmJudge";
import { decodeEmbedding, encodeEmbedding } from "../src/core/matching/vectors";
import type { LlmClient } from "../src/core/ports/llm";
import { makePost, makeWatch } from "./helpers";

function recordingRunner(reply: (model: string, inputs: Record<string, unknown>) => unknown): AiRunner & { calls: { model: string; inputs: Record<string, unknown> }[] } {
  const calls: { model: string; inputs: Record<string, unknown> }[] = [];
  return {
    calls,
    async run(model, inputs) {
      calls.push({ model, inputs });
      return reply(model, inputs);
    },
  };
}

describe("Workers AI embedder", () => {
  it("embeds in batches and reports its model", async () => {
    const runner = recordingRunner((_model, inputs) => {
      const texts = inputs["text"] as string[];
      return { shape: [texts.length, 2], data: texts.map((_, index) => [index, 1]) };
    });
    const embedder = createWorkersAiEmbedder(runner, "@cf/baai/bge-base-en-v1.5", 2);
    const vectors = await embedder.embed(["a", "b", "c"]);
    expect(embedder.model).toBe("@cf/baai/bge-base-en-v1.5");
    expect(runner.calls.map((entry) => entry.inputs["text"])).toEqual([["a", "b"], ["c"]]);
    expect(vectors).toEqual([[0, 1], [1, 1], [0, 1]]);
  });

  it("rejects a reply with the wrong number of vectors", async () => {
    const embedder = createWorkersAiEmbedder(recordingRunner(() => ({ data: [[1]] })));
    await expect(embedder.embed(["a", "b"])).rejects.toThrow(/returned 1 vectors for 2 texts/);
    const empty = createWorkersAiEmbedder(recordingRunner(() => ({})));
    await expect(empty.embed(["a"])).rejects.toThrow(/returned no vectors/);
  });
});

describe("Workers AI REST runner", () => {
  it("calls the account's ai/run endpoint with the token and unwraps result", async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const runner = createRestRunner({
      accountId: "acc123",
      apiToken: "tok",
      fetchFn: async (url, init) => {
        requests.push({ url, init });
        return new Response(JSON.stringify({ success: true, result: { data: [[1, 2]] }, errors: [] }));
      },
    });
    expect(await runner.run("@cf/baai/bge-base-en-v1.5", { text: ["x"] })).toEqual({ data: [[1, 2]] });
    expect(requests[0]!.url).toBe("https://api.cloudflare.com/client/v4/accounts/acc123/ai/run/@cf/baai/bge-base-en-v1.5");
    expect((requests[0]!.init.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok");
  });

  it("surfaces Cloudflare's error messages", async () => {
    const runner = createRestRunner({
      accountId: "a",
      apiToken: "t",
      fetchFn: async () => new Response(JSON.stringify({ success: false, errors: [{ message: "Authentication error" }] }), { status: 401 }),
    });
    await expect(runner.run("m", {})).rejects.toThrow(/HTTP 401 \(Authentication error\)/);
  });
});

describe("Workers AI LLM", () => {
  it("sends the schema in JSON mode with no randomness", async () => {
    const runner = recordingRunner(() => ({ response: { match: true } }));
    const llm = createWorkersAiLlm(runner, "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    const schema = { type: "object", properties: { match: { type: "boolean" } }, required: ["match"], additionalProperties: false };
    expect(await llm.generateJson({ system: "sys", user: "usr", schema, maxTokens: 50 })).toEqual({ match: true });
    expect(runner.calls[0]!.inputs).toMatchObject({
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "usr" },
      ],
      response_format: { type: "json_schema", json_schema: schema },
      max_tokens: 50,
      temperature: 0,
    });
  });

  it("reads every reply shape Workers AI uses", () => {
    expect(readLlmJson({ response: '{"a":1}' })).toEqual({ a: 1 });
    expect(readLlmJson({ response: 'Sure! ```json\n{"a":2}\n```' })).toEqual({ a: 2 });
    expect(readLlmJson({ choices: [{ message: { content: '{"a":3}' } }] })).toEqual({ a: 3 });
    expect(() => readLlmJson({ response: "no json here" })).toThrow(/no JSON object/);
    expect(() => readLlmJson(null)).toThrow(/no result/);
    expect(extractJsonObject('  {"ok":true} ')).toEqual({ ok: true });
  });
});

describe("Anthropic LLM", () => {
  function messageResponse(content: unknown[], stopReason = "end_turn"): Response {
    return new Response(
      JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-haiku-5-5",
        content,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  it("asks for structured JSON at low effort and parses the text block", async () => {
    const bodies: any[] = [];
    const llm = createAnthropicLlm({
      apiKey: "sk-test",
      fetch: (async (_url: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return messageResponse([{ type: "text", text: '{"match":false}' }]);
      }) as typeof fetch,
    });
    const schema = { type: "object", properties: { match: { type: "boolean" } }, required: ["match"], additionalProperties: false };
    expect(await llm.generateJson({ system: "sys", user: "usr", schema, maxTokens: 50 })).toEqual({ match: false });
    expect(bodies[0]).toMatchObject({
      model: "claude-haiku-5-5",
      system: "sys",
      messages: [{ role: "user", content: "usr" }],
      output_config: { effort: "low", format: { type: "json_schema", schema } },
    });
    expect(llm.name).toBe("anthropic claude-haiku-5-5");
  });

  it("treats refusals and truncation as errors", async () => {
    const refusing = createAnthropicLlm({ apiKey: "k", fetch: (async () => messageResponse([], "refusal")) as typeof fetch });
    await expect(refusing.generateJson({ system: "", user: "", schema: {}, maxTokens: 10 })).rejects.toThrow(/declined/);
    const truncated = createAnthropicLlm({ apiKey: "k", fetch: (async () => messageResponse([], "max_tokens")) as typeof fetch });
    await expect(truncated.generateJson({ system: "", user: "", schema: {}, maxTokens: 10 })).rejects.toThrow(/ran out of tokens/);
  });
});

describe("LLM judge", () => {
  const fixedLlm = (answer: unknown): LlmClient => ({
    name: "fixed",
    async generateJson() {
      return answer;
    },
  });

  it("builds a prompt with the watch, store, price and body start", () => {
    const prompt = buildJudgePrompt(
      makePost({ title: "[Costco] Anker Power Bank $29.99", bodyText: "Great deal ".repeat(50) }),
      makeWatch({ label: "Portable charger", intentDescription: "power banks", maxPrice: 40 }),
      30,
    );
    expect(prompt).toContain("Watching for: Portable charger");
    expect(prompt).toContain("Price limit: $40");
    expect(prompt).toContain("Store: Costco");
    expect(prompt).toContain("Price: $29.99");
    // Body cut to 30 characters
    expect(prompt).toContain("Post text: Great deal Great deal Great de");
    expect(prompt).not.toContain("Great deal Great deal Great deal");
  });

  it("returns the model's boolean and throws on anything else", async () => {
    expect(await createLlmJudge(fixedLlm({ match: true })).isMatch(makePost(), makeWatch())).toBe(true);
    expect(await createLlmJudge(fixedLlm({ match: false })).isMatch(makePost(), makeWatch())).toBe(false);
    await expect(createLlmJudge(fixedLlm({ match: "yes" })).isMatch(makePost(), makeWatch())).rejects.toThrow(/boolean/);
  });
});

describe("embedding storage", () => {
  it("round trips through compact base64 float32 text", () => {
    const vector = [0.1, -0.25, 3, 0];
    const stored = encodeEmbedding(vector);
    expect(stored.startsWith("f32:")).toBe(true);
    expect(Array.from(decodeEmbedding(stored))).toEqual(vector.map((value) => Math.fround(value)));
  });

  it("is much smaller than JSON for real sized vectors", () => {
    const vector = Array.from({ length: 768 }, (_, index) => Math.sin(index) / 7);
    expect(encodeEmbedding(vector).length).toBeLessThan(JSON.stringify(vector).length / 3);
  });

  it("still reads the JSON arrays older databases stored", () => {
    expect(Array.from(decodeEmbedding("[1, 0.5]"))).toEqual([1, 0.5]);
    expect(() => decodeEmbedding('{"a":1}')).toThrow(/not an array/);
    expect(() => decodeEmbedding("f32:AAA")).toThrow(/broken length/);
  });
});
