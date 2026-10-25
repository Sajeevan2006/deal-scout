import { buildConfig, consoleLogger, systemClock, type DealScoutConfig } from "./config";
import { createHttpFeedSource } from "./feed/fetchFeed";
import { runFeedCheck, type FeedCheckDeps } from "./pipeline/runFeedCheck";
import type { BorderlineJudge } from "./ports/borderlineJudge";
import type { Database } from "./ports/database";
import type { Embedder } from "./ports/embedder";
import type { Notifier } from "./ports/notifier";
import type { WatchPlanner } from "./ports/watchPlanner";
import type { Watch } from "./types";
import { createWatch } from "./watches/createWatch";

// Worker shaped entry point. Not deployed yet, no Cloudflare packages, just the same shape.

// Minimal local stand in for the Cloudflare bindings
export interface Env {
  // D1Database already matches our Database port
  DB?: Database;
  AI?: unknown;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  CONTACT_EMAIL?: string;
}

export interface ScheduledEventLike {
  cron: string;
  scheduledTime: number;
}

export interface WorkerDeps extends FeedCheckDeps {
  planner: WatchPlanner;
}

function notImplemented(what: string): never {
  throw new Error(`${what} is not implemented yet. Phase 1 runs locally, see README.`);
}

function configFromEnv(env: Env): DealScoutConfig {
  if (env.CONTACT_EMAIL) {
    return buildConfig({ userAgent: `DealScout/0.1 (personal use, contact ${env.CONTACT_EMAIL})` });
  }
  return buildConfig();
}

export function buildDepsFromEnv(env: Env): WorkerDeps {
  const config = configFromEnv(env);
  // TODO(integration): D1 adapter. env.DB should drop straight in, add a thin wrapper only if types drift.
  const db = env.DB ?? notImplemented("D1 binding (env.DB)");
  const feedSource = createHttpFeedSource(config, {
    fetchFn: (url, init) => fetch(url, init),
    clock: systemClock,
    logger: consoleLogger,
  });
  // TODO(integration): Workers AI embedder using env.AI
  const embedder: Embedder = {
    async embed() {
      return notImplemented("Workers AI embedder");
    },
  };
  // TODO(integration): real LLM planner with tool calling (watches/watchTools.ts)
  const planner: WatchPlanner = {
    async planWatch() {
      return notImplemented("LLM watch planner");
    },
  };
  // TODO(integration): LLM borderline judge
  const judge: BorderlineJudge = {
    async isMatch() {
      return notImplemented("LLM borderline judge");
    },
  };
  // TODO(integration): Telegram notifier using env.TELEGRAM_BOT_TOKEN and env.TELEGRAM_CHAT_ID
  const notifier: Notifier = {
    async sendAlert() {
      return notImplemented("Telegram notifier");
    },
  };
  return { db, feedSource, embedder, planner, judge, notifier, clock: systemClock, logger: consoleLogger, config };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function readCreateWatchBody(body: unknown): { userId: string; text: string } | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const fields = body as Record<string, unknown>;
  const userId = fields["userId"];
  const text = fields["text"];
  if (typeof userId !== "string" || typeof text !== "string") {
    return null;
  }
  if (userId.trim().length === 0 || text.trim().length === 0) {
    return null;
  }
  return { userId: userId.trim(), text };
}

function publicWatch(watch: Watch): Omit<Watch, "intentEmbedding"> {
  const { intentEmbedding: _embedding, ...rest } = watch;
  return rest;
}

export function createWorker(buildDeps: (env: Env) => WorkerDeps) {
  return {
    // TODO(integration): Telegram webhook lands here. Check its secret token header before trusting the body.
    async fetch(request: Request, env: Env): Promise<Response> {
      if (request.method !== "POST") {
        return jsonResponse({ error: 'POST a JSON body like {"userId": "...", "text": "..."}' }, 405);
      }
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: "Body must be JSON" }, 400);
      }
      const createRequest = readCreateWatchBody(body);
      if (createRequest === null) {
        return jsonResponse({ error: "Need non empty string fields userId and text" }, 400);
      }
      try {
        const deps = buildDeps(env);
        const watch = await createWatch(createRequest.userId, createRequest.text, deps);
        return jsonResponse({ watch: publicWatch(watch) }, 201);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return jsonResponse({ error: message }, 500);
      }
    },

    async scheduled(event: ScheduledEventLike, env: Env): Promise<void> {
      const deps = buildDeps(env);
      const summary = await runFeedCheck(deps);
      deps.logger.info(`Scheduled check (${event.cron}): ${summary.message}`);
    },
  };
}

const worker = createWorker(buildDepsFromEnv);

export default worker;
