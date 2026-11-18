import { createAnthropicLlm, DEFAULT_ANTHROPIC_MODEL } from "../adapters/anthropicLlm";
import { createLogNotifier, createTelegramNotifier } from "../adapters/notifiers";
import { createTelegramApi, type TelegramApi } from "../adapters/telegram/api";
import { getOwnerChatId } from "../adapters/telegram/bot";
import {
  createBindingRunner,
  createWorkersAiEmbedder,
  createWorkersAiLlm,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_WORKERS_AI_LLM_MODEL,
  type AiBinding,
} from "../adapters/workersAi";
import { buildConfig, consoleLogger, systemClock, type DealScoutConfig } from "../core/config";
import { createHttpFeedSource } from "../core/feed/fetchFeed";
import { createLlmJudge } from "../core/matching/llmJudge";
import type { FeedCheckDeps } from "../core/pipeline/runFeedCheck";
import type { Database } from "../core/ports/database";
import type { LlmClient } from "../core/ports/llm";
import type { Notifier } from "../core/ports/notifier";
import type { WatchPlanner } from "../core/ports/watchPlanner";
import type { Logger } from "../core/types";
import { createLlmWatchPlanner } from "../core/watches/llmWatchPlanner";

// The bindings, vars and secrets the Worker reads. Typed by hand (no Cloudflare type packages),
// D1 already matches our Database port.
export interface Env {
  DB?: Database;
  AI?: AiBinding;
  // [vars] in wrangler.toml
  CONTACT_EMAIL?: string;
  EMBEDDING_MODEL?: string;
  LLM_PROVIDER?: string;
  PLANNER_MODEL?: string;
  JUDGE_MODEL?: string;
  HIGH_THRESHOLD?: string;
  LOW_THRESHOLD?: string;
  MAX_JUDGE_CALLS_PER_RUN?: string;
  MAX_JUDGE_CALLS_PER_DAY?: string;
  // Secrets (wrangler secret put)
  ADMIN_TOKEN?: string;
  PAIRING_CODE?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  ANTHROPIC_API_KEY?: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const PLACEHOLDER_CONTACTS = new Set(["", "me@example.com", "you@example.com"]);

function readNumber(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new ConfigError(`${name} must be a number, got "${value}"`);
  }
  return parsed;
}

export function embeddingModelFromEnv(env: Env): string {
  return env.EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL;
}

export function configFromEnv(env: Env): DealScoutConfig {
  const contact = env.CONTACT_EMAIL?.trim() ?? "";
  if (PLACEHOLDER_CONTACTS.has(contact)) {
    throw new ConfigError(
      "Set CONTACT_EMAIL under [vars] in wrangler.toml. It goes in the User-Agent so RFD can reach you if something goes wrong.",
    );
  }
  const base = buildConfig({
    userAgent: `DealScout/0.2 (personal use, contact ${contact})`,
    // A cron run should not sleep minutes waiting to retry; the next run 10 minutes later retries
    errorRetryCount: 0,
  });
  const overrides: Partial<DealScoutConfig> = {};
  const perRun = readNumber(env.MAX_JUDGE_CALLS_PER_RUN, "MAX_JUDGE_CALLS_PER_RUN");
  const perDay = readNumber(env.MAX_JUDGE_CALLS_PER_DAY, "MAX_JUDGE_CALLS_PER_DAY");
  if (perRun !== undefined) {
    overrides.maxJudgeCallsPerRun = perRun;
  }
  if (perDay !== undefined) {
    overrides.maxJudgeCallsPerDay = perDay;
  }
  const high = readNumber(env.HIGH_THRESHOLD, "HIGH_THRESHOLD");
  const low = readNumber(env.LOW_THRESHOLD, "LOW_THRESHOLD");
  if (high !== undefined || low !== undefined) {
    const model = embeddingModelFromEnv(env);
    const current = base.thresholdsByEmbeddingModel[model] ?? { high: base.defaultHighThreshold, low: base.defaultLowThreshold };
    const pair = { high: high ?? current.high, low: low ?? current.low };
    if (pair.low > pair.high) {
      throw new ConfigError(`LOW_THRESHOLD (${pair.low}) can't be above HIGH_THRESHOLD (${pair.high})`);
    }
    overrides.thresholdsByEmbeddingModel = { ...base.thresholdsByEmbeddingModel, [model]: pair };
  }
  return buildConfig({ ...base, ...overrides });
}

export type LlmProvider = "workers-ai" | "anthropic";

export function llmProviderFromEnv(env: Env): LlmProvider {
  const provider = (env.LLM_PROVIDER?.trim() || "workers-ai").toLowerCase();
  if (provider !== "workers-ai" && provider !== "anthropic") {
    throw new ConfigError(`LLM_PROVIDER must be "workers-ai" or "anthropic", got "${env.LLM_PROVIDER}"`);
  }
  return provider;
}

function buildLlms(env: Env): { planner: LlmClient; judge: LlmClient } {
  const provider = llmProviderFromEnv(env);
  if (provider === "anthropic") {
    const apiKey = env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) {
      throw new ConfigError("LLM_PROVIDER is anthropic but the ANTHROPIC_API_KEY secret is not set");
    }
    return {
      planner: createAnthropicLlm({ apiKey, model: env.PLANNER_MODEL?.trim() || DEFAULT_ANTHROPIC_MODEL }),
      judge: createAnthropicLlm({ apiKey, model: env.JUDGE_MODEL?.trim() || DEFAULT_ANTHROPIC_MODEL }),
    };
  }
  const runner = createBindingRunner(requireAi(env));
  return {
    planner: createWorkersAiLlm(runner, env.PLANNER_MODEL?.trim() || DEFAULT_WORKERS_AI_LLM_MODEL),
    judge: createWorkersAiLlm(runner, env.JUDGE_MODEL?.trim() || DEFAULT_WORKERS_AI_LLM_MODEL),
  };
}

function requireAi(env: Env): AiBinding {
  if (!env.AI) {
    throw new ConfigError('The Workers AI binding is missing. wrangler.toml needs [ai] binding = "AI".');
  }
  return env.AI;
}

export function requireDb(env: Env): Database {
  if (!env.DB) {
    throw new ConfigError("The D1 binding is missing. wrangler.toml needs a [[d1_databases]] entry with binding = \"DB\".");
  }
  return env.DB;
}

export function telegramApiFromEnv(env: Env): TelegramApi | null {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  return token ? createTelegramApi(token) : null;
}

// Sends to the paired Telegram chat, or to the logs when Telegram isn't set up or paired yet
export function createOwnerNotifier(db: Database, telegram: TelegramApi | null, logger: Logger): Notifier {
  const logNotifier = createLogNotifier(logger);
  let resolved: Notifier | null = null;
  return {
    async sendAlert(alert) {
      if (resolved === null) {
        const ownerChatId = telegram === null ? null : await getOwnerChatId(db);
        if (telegram !== null && ownerChatId === null) {
          logger.warn("Telegram is configured but not paired yet (send /start <PAIRING_CODE> to the bot). Logging alerts instead.");
        }
        resolved = telegram !== null && ownerChatId !== null ? createTelegramNotifier(telegram, ownerChatId) : logNotifier;
      }
      await resolved.sendAlert(alert);
    },
  };
}

export interface WorkerDeps extends FeedCheckDeps {
  planner: WatchPlanner;
  telegram: TelegramApi | null;
  env: Env;
}

export interface BuildDepsOptions {
  force?: boolean;
}

export function buildDepsFromEnv(env: Env, options: BuildDepsOptions = {}): WorkerDeps {
  const config = configFromEnv(env);
  const db = requireDb(env);
  const logger = consoleLogger;
  const embedder = createWorkersAiEmbedder(createBindingRunner(requireAi(env)), embeddingModelFromEnv(env));
  const llms = buildLlms(env);
  const telegram = telegramApiFromEnv(env);
  const feedSource = createHttpFeedSource(
    config,
    { fetchFn: (url, init) => fetch(url, init), clock: systemClock, logger },
    { force: options.force === true },
  );
  return {
    db,
    feedSource,
    embedder,
    judge: createLlmJudge(llms.judge, { bodyChars: config.matchTextBodyChars }),
    planner: createLlmWatchPlanner(llms.planner, { logger }),
    notifier: createOwnerNotifier(db, telegram, logger),
    telegram,
    clock: systemClock,
    logger,
    config,
    env,
  };
}
