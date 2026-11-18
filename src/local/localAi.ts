import { createAnthropicLlm, DEFAULT_ANTHROPIC_MODEL } from "../adapters/anthropicLlm";
import {
  createRestRunner,
  createWorkersAiEmbedder,
  createWorkersAiLlm,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_WORKERS_AI_LLM_MODEL,
} from "../adapters/workersAi";
import { consoleLogger } from "../core/config";
import { createLlmJudge } from "../core/matching/llmJudge";
import type { BorderlineJudge } from "../core/ports/borderlineJudge";
import type { Embedder } from "../core/ports/embedder";
import type { LlmClient } from "../core/ports/llm";
import type { WatchPlanner } from "../core/ports/watchPlanner";
import type { Logger } from "../core/types";
import { createLlmWatchPlanner } from "../core/watches/llmWatchPlanner";
import { createRuleWatchPlanner } from "../core/watches/rulePlanner";
import { createFakeEmbedder } from "./fakeEmbedder";
import { createStubBorderlineJudge } from "./stubBorderlineJudge";

// Picks real or offline AI for the local CLI and eval, from .env:
// - CLOUDFLARE_ACCOUNT_ID + WORKERS_AI_API_TOKEN: Workers AI over REST (same models as the Worker)
// - LLM_PROVIDER=anthropic + ANTHROPIC_API_KEY: Claude for the planner and judge
// - neither: fake embedder, rule planner, judge that always says no

export interface LocalAi {
  embedder: Embedder;
  planner: WatchPlanner;
  judge: BorderlineJudge;
  description: string;
}

function workersAiRunner() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const apiToken = process.env.WORKERS_AI_API_TOKEN?.trim();
  if (!accountId || !apiToken) {
    return null;
  }
  return createRestRunner({ accountId, apiToken });
}

export function createLocalEmbedder(kind: "auto" | "fake" | "workers-ai" = "auto", fakeDimensions = 256): Embedder {
  const runner = workersAiRunner();
  if (kind === "fake" || (kind === "auto" && runner === null)) {
    return createFakeEmbedder(fakeDimensions);
  }
  if (runner === null) {
    throw new Error("Set CLOUDFLARE_ACCOUNT_ID and WORKERS_AI_API_TOKEN in .env to use Workers AI locally (see .env.example)");
  }
  return createWorkersAiEmbedder(runner, process.env.EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL);
}

// The planner and judge LLMs, or null when nothing is configured
export function createLocalLlms(): { planner: LlmClient; judge: LlmClient } | null {
  const provider = (process.env.LLM_PROVIDER?.trim() || "workers-ai").toLowerCase();
  if (provider === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("LLM_PROVIDER=anthropic needs ANTHROPIC_API_KEY in .env");
    }
    return {
      planner: createAnthropicLlm({ apiKey, model: process.env.PLANNER_MODEL?.trim() || DEFAULT_ANTHROPIC_MODEL }),
      judge: createAnthropicLlm({ apiKey, model: process.env.JUDGE_MODEL?.trim() || DEFAULT_ANTHROPIC_MODEL }),
    };
  }
  const runner = workersAiRunner();
  if (runner === null) {
    return null;
  }
  return {
    planner: createWorkersAiLlm(runner, process.env.PLANNER_MODEL?.trim() || DEFAULT_WORKERS_AI_LLM_MODEL),
    judge: createWorkersAiLlm(runner, process.env.JUDGE_MODEL?.trim() || DEFAULT_WORKERS_AI_LLM_MODEL),
  };
}

export function createLocalAi(bodyChars: number, logger: Logger = consoleLogger): LocalAi {
  const embedder = createLocalEmbedder();
  const llms = createLocalLlms();
  if (llms === null) {
    return {
      embedder,
      planner: createRuleWatchPlanner(),
      judge: createStubBorderlineJudge(logger),
      description: `embedder ${embedder.model}, rule planner, stub judge (set up .env for real AI)`,
    };
  }
  return {
    embedder,
    planner: createLlmWatchPlanner(llms.planner, { logger }),
    judge: createLlmJudge(llms.judge, { bodyChars }),
    description: `embedder ${embedder.model}, planner ${llms.planner.name}, judge ${llms.judge.name}`,
  };
}
