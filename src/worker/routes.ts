import { constantTimeEqual, readBearerToken } from "../adapters/security";
import type { TelegramUpdate } from "../adapters/telegram/api";
import { getOwnerChatId, handleTelegramUpdate, OWNER_USER_ID } from "../adapters/telegram/bot";
import { BOT_COMMANDS } from "../adapters/telegram/format";
import {
  deactivateWatch,
  deleteAppState,
  getCounter,
  getFeedState,
  getWatch,
  judgeCounterKey,
  listSeenPostsSince,
  listWatchesForUser,
  OWNER_CHAT_ID_KEY,
  unblockFeed,
  updateWatchThresholds,
} from "../core/db/queries";
import { recordAlertFeedback } from "../core/feedback/recordFeedback";
import { runFeedCheck, type FeedCheckSummary } from "../core/pipeline/runFeedCheck";
import type { FeedbackRating, Watch } from "../core/types";
import { createWatch } from "../core/watches/createWatch";
import { ConfigError, embeddingModelFromEnv, llmProviderFromEnv, type BuildDepsOptions, type Env, type WorkerDeps } from "./deps";

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export type DepsBuilder = (env: Env, options?: BuildDepsOptions) => WorkerDeps;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json" } });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.trim() === "") {
    return {};
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, "Body must be JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "Body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

function publicWatch(watch: Watch) {
  const { intentEmbedding: _embedding, ...rest } = watch;
  return rest;
}

// The summary without the full decision objects (they hold embeddings)
export function publicSummary(summary: FeedCheckSummary) {
  const { decisions, ...rest } = summary;
  return {
    ...rest,
    decisions: decisions.map((decision) => ({
      watch: decision.watch.label,
      post: decision.post.title,
      score: Number(decision.score.toFixed(3)),
      alert: decision.shouldAlert,
      reason: decision.reason,
      detail: decision.detail,
    })),
  };
}

function parseId(text: string | undefined, name: string): number {
  const id = Number(text);
  if (!Number.isInteger(id) || id <= 0) {
    throw new HttpError(400, `${name} must be a positive whole number`);
  }
  return id;
}

async function ownedWatch(deps: WorkerDeps, watchId: number): Promise<Watch> {
  const watch = await getWatch(deps.db, watchId);
  if (watch === null || watch.userId !== OWNER_USER_ID) {
    throw new HttpError(404, `No watch #${watchId}`);
  }
  return watch;
}

function readThreshold(value: unknown, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < -1 || value > 1) {
    throw new HttpError(400, `${name} must be a number between -1 and 1`);
  }
  return value;
}

async function handleStatus(deps: WorkerDeps): Promise<Response> {
  const feedState = await getFeedState(deps.db, deps.config.feedUrl);
  const watches = await listWatchesForUser(deps.db, OWNER_USER_ID, true);
  const ownerChatId = await getOwnerChatId(deps.db);
  return json({
    feed: feedState,
    activeWatches: watches.length,
    judgeCallsToday: await getCounter(deps.db, judgeCounterKey(deps.clock.now())),
    limits: { maxJudgeCallsPerRun: deps.config.maxJudgeCallsPerRun, maxJudgeCallsPerDay: deps.config.maxJudgeCallsPerDay },
    ai: {
      embeddingModel: embeddingModelFromEnv(deps.env),
      llmProvider: llmProviderFromEnv(deps.env),
      defaultThresholds: deps.config.thresholdsByEmbeddingModel[embeddingModelFromEnv(deps.env)] ?? null,
    },
    telegram: { configured: deps.telegram !== null, paired: ownerChatId !== null },
  });
}

async function handleApi(request: Request, env: Env, url: URL, buildDeps: DepsBuilder): Promise<Response> {
  const adminToken = env.ADMIN_TOKEN?.trim();
  if (!adminToken) {
    return json({ error: "The admin API is off until you set the ADMIN_TOKEN secret (wrangler secret put ADMIN_TOKEN)." }, 503);
  }
  const provided = readBearerToken(request.headers.get("Authorization"));
  if (provided === null || !constantTimeEqual(provided, adminToken)) {
    return json({ error: "Missing or wrong bearer token" }, 401);
  }

  const path = url.pathname.replace(/\/+$/, "");
  const method = request.method;
  const segments = path.split("/").filter(Boolean); // ["api", ...]

  if (method === "POST" && path === "/api/check") {
    const body = await readJsonBody(request);
    const deps = buildDeps(env, { force: body["force"] === true });
    const summary = await runFeedCheck(deps, { alertExisting: body["alertExisting"] === true });
    return json(publicSummary(summary));
  }

  const deps = buildDeps(env);

  if (method === "GET" && path === "/api/status") {
    return handleStatus(deps);
  }
  if (method === "GET" && path === "/api/watches") {
    const watches = await listWatchesForUser(deps.db, OWNER_USER_ID, url.searchParams.get("all") !== "1");
    return json({ watches: watches.map(publicWatch) });
  }
  if (method === "POST" && path === "/api/watches") {
    const body = await readJsonBody(request);
    const text = body["text"];
    if (typeof text !== "string" || text.trim() === "") {
      throw new HttpError(400, 'Send {"text": "what to watch for"}');
    }
    const watch = await createWatch(OWNER_USER_ID, text, deps);
    return json({ watch: publicWatch(watch) }, 201);
  }
  if (segments[0] === "api" && segments[1] === "watches" && segments.length === 3 && method === "DELETE") {
    const watchId = parseId(segments[2], "watch id");
    await ownedWatch(deps, watchId);
    const removed = await deactivateWatch(deps.db, watchId);
    return json({ removed, watchId });
  }
  if (segments[0] === "api" && segments[1] === "watches" && segments[3] === "thresholds" && method === "POST") {
    const watch = await ownedWatch(deps, parseId(segments[2], "watch id"));
    const body = await readJsonBody(request);
    const high = readThreshold(body["high"], "high") ?? watch.highThreshold;
    const low = readThreshold(body["low"], "low") ?? watch.lowThreshold;
    if (low > high) {
      throw new HttpError(400, "low can't be above high");
    }
    await updateWatchThresholds(deps.db, watch.id, high, low);
    return json({ watchId: watch.id, high, low });
  }
  if (method === "POST" && path === "/api/feedback") {
    const body = await readJsonBody(request);
    const alertId = parseId(String(body["alertId"]), "alertId");
    const rating = body["rating"];
    if (rating !== "up" && rating !== "down") {
      throw new HttpError(400, 'rating must be "up" or "down"');
    }
    const outcome = await recordAlertFeedback(deps.db, alertId, rating as FeedbackRating, deps.clock.now().toISOString(), deps.config.thresholdTuning);
    return json({ alertId, rating, watchId: outcome.watch?.id ?? null, threshold: outcome.suggestion });
  }
  if (method === "POST" && path === "/api/unblock") {
    const unblocked = await unblockFeed(deps.db, deps.config.feedUrl);
    return json({
      unblocked,
      note: unblocked ? "Live fetches allowed again. Check why it was blocked first." : "The feed was not marked blocked.",
    });
  }
  if (method === "GET" && path === "/api/posts") {
    const days = Number(url.searchParams.get("days") ?? "30");
    const since = new Date(deps.clock.now().getTime() - Math.max(1, days) * 24 * 60 * 60 * 1000).toISOString();
    return json({ posts: await listSeenPostsSince(deps.db, since) });
  }
  if (method === "POST" && path === "/api/telegram/setup") {
    const secret = env.TELEGRAM_WEBHOOK_SECRET?.trim();
    if (deps.telegram === null || !secret) {
      throw new HttpError(400, "Set the TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET secrets first.");
    }
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
      throw new HttpError(400, "TELEGRAM_WEBHOOK_SECRET may only use letters, digits, _ and - (Telegram's rule).");
    }
    const webhookUrl = new URL("/telegram/webhook", url.origin).href;
    await deps.telegram.setWebhook(webhookUrl, secret);
    await deps.telegram.setMyCommands(BOT_COMMANDS);
    return json({ webhookUrl, commands: BOT_COMMANDS.map((command) => command.command), next: "Message your bot: /start <PAIRING_CODE>" });
  }
  if (method === "GET" && path === "/api/telegram/status") {
    if (deps.telegram === null) {
      return json({ configured: false });
    }
    return json({ configured: true, paired: (await getOwnerChatId(deps.db)) !== null, webhook: await deps.telegram.getWebhookInfo() });
  }
  if (method === "POST" && path === "/api/telegram/unpair") {
    await deleteAppState(deps.db, OWNER_CHAT_ID_KEY);
    return json({ unpaired: true, next: "Send /start <PAIRING_CODE> from the chat that should own the bot." });
  }
  throw new HttpError(404, `No route ${method} ${path}`);
}

async function handleTelegramWebhook(request: Request, env: Env, ctx: ExecutionContextLike, buildDeps: DepsBuilder): Promise<Response> {
  const secret = env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!env.TELEGRAM_BOT_TOKEN || !secret) {
    return json({ error: "Telegram is not configured" }, 404);
  }
  const provided = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (!constantTimeEqual(provided, secret)) {
    return json({ error: "Bad secret token" }, 401);
  }
  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    return json({ error: "Body must be JSON" }, 400);
  }
  const deps = buildDeps(env);
  if (deps.telegram === null) {
    return json({ error: "Telegram is not configured" }, 404);
  }
  const telegram = deps.telegram;
  // Answer Telegram right away; LLM planning can take a few seconds
  ctx.waitUntil(
    handleTelegramUpdate(update, {
      db: deps.db,
      api: telegram,
      pairingCode: env.PAIRING_CODE?.trim() || undefined,
      planner: deps.planner,
      embedder: deps.embedder,
      clock: deps.clock,
      logger: deps.logger,
      config: deps.config,
    }).catch((error: unknown) => deps.logger.error(`Telegram update ${update.update_id} failed: ${describeError(error)}`)),
  );
  return new Response("ok");
}

export async function handleRequest(request: Request, env: Env, ctx: ExecutionContextLike, buildDeps: DepsBuilder): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (url.pathname === "/" && request.method === "GET") {
      return new Response("Deal Scout is running. See the README for the admin API and Telegram setup.\n");
    }
    if (url.pathname === "/telegram/webhook" && request.method === "POST") {
      return await handleTelegramWebhook(request, env, ctx, buildDeps);
    }
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return await handleApi(request, env, url, buildDeps);
    }
    return json({ error: "Not found" }, 404);
  } catch (error) {
    if (error instanceof HttpError) {
      return json({ error: error.message }, error.status);
    }
    if (error instanceof ConfigError) {
      return json({ error: `Configuration problem: ${error.message}` }, 500);
    }
    console.error(`Request ${request.method} ${url.pathname} failed: ${describeError(error)}`);
    return json({ error: describeError(error) }, 500);
  }
}
