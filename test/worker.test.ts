import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TelegramApi } from "../src/adapters/telegram/api";
import { buildConfig, silentLogger, type DealScoutConfig } from "../src/core/config";
import { getAppState, getFeedState, listActiveWatches, OWNER_CHAT_ID_KEY, recordFeedRequest } from "../src/core/db/queries";
import type { Notifier } from "../src/core/ports/notifier";
import type { Clock, DealAlert } from "../src/core/types";
import { createRuleWatchPlanner } from "../src/core/watches/rulePlanner";
import { buildDepsFromEnv, configFromEnv, type Env, type WorkerDeps } from "../src/worker/deps";
import { createWorker } from "../src/worker/index";
import type { ExecutionContextLike } from "../src/worker/routes";
import { createFakeEmbedder } from "../src/local/fakeEmbedder";
import { createFileFeedSource } from "../src/local/fileFeedSource";
import { openSqliteDatabase, type SqliteDatabase } from "../src/local/sqliteDatabase";
import { fixturesDir, realFeedPath } from "./helpers";

const migrationsDir = path.join(fixturesDir, "..", "..", "migrations");
const ADMIN_TOKEN = "admin-secret";
const WEBHOOK_SECRET = "hook_secret-1";
const env: Env = {
  ADMIN_TOKEN,
  PAIRING_CODE: "pair-me",
  TELEGRAM_BOT_TOKEN: "123:abc",
  TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
  CONTACT_EMAIL: "someone@example.org",
};

const fixedClock: Clock = {
  now() {
    return new Date("2026-10-26T12:00:00.000Z");
  },
  async sleep() {},
};

interface TelegramCall {
  method: string;
  args: unknown[];
}

function fakeTelegram(): TelegramApi & { calls: TelegramCall[] } {
  const calls: TelegramCall[] = [];
  const record =
    (method: string) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (...args: unknown[]): Promise<any> => {
      calls.push({ method, args });
      return { message_id: calls.length, chat: { id: 0, type: "private" } };
    };
  return {
    calls,
    sendMessage: record("sendMessage") as TelegramApi["sendMessage"],
    editMessageText: record("editMessageText") as TelegramApi["editMessageText"],
    editMessageReplyMarkup: record("editMessageReplyMarkup") as TelegramApi["editMessageReplyMarkup"],
    answerCallbackQuery: record("answerCallbackQuery") as TelegramApi["answerCallbackQuery"],
    sendChatAction: record("sendChatAction") as TelegramApi["sendChatAction"],
    setWebhook: record("setWebhook") as TelegramApi["setWebhook"],
    setMyCommands: record("setMyCommands") as TelegramApi["setMyCommands"],
    getWebhookInfo: record("getWebhookInfo") as TelegramApi["getWebhookInfo"],
  };
}

let db: SqliteDatabase;
let telegram: ReturnType<typeof fakeTelegram>;
let alerts: DealAlert[];
let pending: Promise<unknown>[];
const ctx: ExecutionContextLike = {
  waitUntil(promise) {
    pending.push(promise);
  },
};

function localDeps(currentEnv: Env, config: DealScoutConfig = buildConfig()): WorkerDeps {
  const notifier: Notifier = {
    async sendAlert(alert) {
      alerts.push(alert);
    },
  };
  return {
    db,
    feedSource: createFileFeedSource(realFeedPath),
    embedder: createFakeEmbedder(),
    planner: createRuleWatchPlanner(),
    // Says yes to Bose posts in the borderline band
    judge: { isMatch: async (post) => post.title.includes("Bose") },
    notifier,
    telegram: currentEnv.TELEGRAM_BOT_TOKEN ? telegram : null,
    clock: fixedClock,
    logger: silentLogger,
    config,
    env: currentEnv,
  };
}

const worker = createWorker((currentEnv) => localDeps(currentEnv));

function api(method: string, apiPath: string, body?: unknown, token: string | null = ADMIN_TOKEN): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== null) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return new Request(`https://deal-scout.example.workers.dev${apiPath}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function call(request: Request, currentEnv: Env = env): Promise<{ status: number; body: any }> {
  const response = await worker.fetch(request, currentEnv, ctx);
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // plain text
  }
  return { status: response.status, body };
}

beforeEach(() => {
  db = openSqliteDatabase(":memory:", migrationsDir);
  telegram = fakeTelegram();
  alerts = [];
  pending = [];
});

afterEach(() => {
  db.close();
});

describe("admin API auth", () => {
  it("is off without ADMIN_TOKEN and rejects a wrong token", async () => {
    expect((await call(api("GET", "/api/status"), { ...env, ADMIN_TOKEN: undefined })).status).toBe(503);
    expect((await call(api("GET", "/api/status", undefined, "nope"))).status).toBe(401);
    expect((await call(api("GET", "/api/status", undefined, null))).status).toBe(401);
    expect((await call(api("GET", "/api/status"))).status).toBe(200);
  });

  it("answers the health check and 404s unknown paths", async () => {
    const health = await worker.fetch(new Request("https://x.dev/"), env, ctx);
    expect(health.status).toBe(200);
    expect((await call(api("GET", "/api/nothing-here"))).status).toBe(404);
    expect((await call(new Request("https://x.dev/elsewhere"))).status).toBe(404);
  });
});

describe("admin API watches", () => {
  it("creates, lists, retunes and removes watches", async () => {
    const created = await call(api("POST", "/api/watches", { text: "air fryer under $100" }));
    expect(created.status).toBe(201);
    expect(created.body.watch).toMatchObject({ label: "air fryer", maxPrice: 100, userId: "owner" });
    expect(created.body.watch).not.toHaveProperty("intentEmbedding");
    const watchId = created.body.watch.id;

    const listed = await call(api("GET", "/api/watches"));
    expect(listed.body.watches).toHaveLength(1);

    const tuned = await call(api("POST", `/api/watches/${watchId}/thresholds`, { high: 0.85, low: 0.65 }));
    expect(tuned.body).toEqual({ watchId, high: 0.85, low: 0.65 });
    expect((await call(api("POST", `/api/watches/${watchId}/thresholds`, { high: 0.5, low: 0.7 }))).status).toBe(400);

    expect((await call(api("DELETE", `/api/watches/${watchId}`))).body).toEqual({ removed: true, watchId });
    expect(await listActiveWatches(db)).toHaveLength(0);
    expect((await call(api("DELETE", "/api/watches/999"))).status).toBe(404);
  });

  it("rejects bad bodies", async () => {
    expect((await call(api("POST", "/api/watches", { text: "  " }))).status).toBe(400);
    const badJson = new Request("https://x.dev/api/watches", {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: "{nope",
    });
    expect((await call(badJson)).status).toBe(400);
  });
});

describe("admin API checks and status", () => {
  it("runs a check, reports status, lists seen posts and takes feedback", async () => {
    await call(api("POST", "/api/watches", { text: "Bose QuietComfort headphones" }));
    const firstCheck = await call(api("POST", "/api/check", {}));
    expect(firstCheck.body).toMatchObject({ outcome: "ok", firstRun: true, newPosts: 15, alerted: 0 });

    const status = await call(api("GET", "/api/status"));
    expect(status.body).toMatchObject({ activeWatches: 1, telegram: { configured: true, paired: false } });
    expect(status.body.ai.embeddingModel).toBe("@cf/baai/bge-base-en-v1.5");

    expect((await call(api("GET", "/api/posts?days=abc"))).status).toBe(400);
    expect((await call(api("GET", "/api/posts?days=999"))).status).toBe(400);
    const posts = await call(api("GET", "/api/posts?days=7"));
    expect(posts.body.posts).toHaveLength(15);
    expect(posts.body.posts[0]).toHaveProperty("bodySnippet");

    // A second database without the first run flag alerts on existing posts
    await db.prepare("DELETE FROM seen_posts").run();
    await db.prepare("DELETE FROM app_state").run();
    const alertingCheck = await call(api("POST", "/api/check", { alertExisting: true }));
    expect(alertingCheck.body.alerted).toBe(1);
    expect(alertingCheck.body.decisions[0]).not.toHaveProperty("intentEmbedding");
    const alertId = alerts[0]!.alertId;

    const feedback = await call(api("POST", "/api/feedback", { alertId, rating: "down" }));
    expect(feedback.body).toMatchObject({ alertId, rating: "down" });
    expect((await call(api("POST", "/api/feedback", { alertId, rating: "meh" }))).status).toBe(400);
  });

  it("unblocks the feed only when it was blocked", async () => {
    const config = buildConfig();
    expect((await call(api("POST", "/api/unblock"))).body.unblocked).toBe(false);
    await recordFeedRequest(db, config.feedUrl, "2026-10-26T11:00:00.000Z", "blocked", null);
    expect((await call(api("POST", "/api/unblock"))).body.unblocked).toBe(true);
    expect((await getFeedState(db, config.feedUrl)).lastStatus).toBe("unblocked");
  });
});

describe("Telegram webhook", () => {
  const update = (updateId: number, text: string) => ({
    update_id: updateId,
    message: { message_id: 1, chat: { id: 42, type: "private" }, text },
  });

  function webhook(body: unknown, secret: string | null = WEBHOOK_SECRET): Request {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (secret !== null) {
      headers["X-Telegram-Bot-Api-Secret-Token"] = secret;
    }
    return new Request("https://x.dev/telegram/webhook", { method: "POST", headers, body: JSON.stringify(body) });
  }

  it("needs Telegram configured and the right secret header", async () => {
    expect((await call(webhook(update(1, "/start pair-me")), { ...env, TELEGRAM_BOT_TOKEN: undefined })).status).toBe(404);
    expect((await call(webhook(update(1, "/start pair-me"), "wrong"))).status).toBe(401);
    expect((await call(webhook(update(1, "/start pair-me"), null))).status).toBe(401);
    expect(pending).toHaveLength(0);
  });

  it("answers right away and handles the update in waitUntil", async () => {
    const response = await call(webhook(update(1, "/start pair-me")));
    expect(response.status).toBe(200);
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(await getAppState(db, OWNER_CHAT_ID_KEY)).toBe("42");
    expect(telegram.calls.some((entry) => entry.method === "sendMessage")).toBe(true);
  });

  it("registers the webhook at this Worker's own URL", async () => {
    const setup = await call(api("POST", "/api/telegram/setup"));
    expect(setup.status).toBe(200);
    expect(setup.body.webhookUrl).toBe("https://deal-scout.example.workers.dev/telegram/webhook");
    expect(telegram.calls.map((entry) => entry.method)).toEqual(["setWebhook", "setMyCommands"]);
    expect(telegram.calls[0]!.args).toEqual(["https://deal-scout.example.workers.dev/telegram/webhook", WEBHOOK_SECRET]);
  });

  it("refuses setup with a webhook secret Telegram would reject", async () => {
    const badEnv = { ...env, TELEGRAM_WEBHOOK_SECRET: "has spaces!" };
    expect((await call(api("POST", "/api/telegram/setup"), badEnv)).status).toBe(400);
  });

  it("can unpair the owner", async () => {
    await call(webhook(update(1, "/start pair-me")));
    await Promise.all(pending);
    expect((await call(api("POST", "/api/telegram/unpair"))).body.unpaired).toBe(true);
    expect(await getAppState(db, OWNER_CHAT_ID_KEY)).toBeNull();
  });
});

describe("scheduled", () => {
  it("runs a feed check", async () => {
    await worker.scheduled({ cron: "*/10 * * * *", scheduledTime: Date.now() }, env, ctx);
    const row = await db.prepare("SELECT COUNT(*) AS total FROM seen_posts").first<{ total: number }>();
    expect(row?.total).toBe(15);
  });
});

describe("configuration from env", () => {
  it("only adds a contact to the User-Agent when one is given", () => {
    expect(configFromEnv({}).userAgent).toBe("DealScout/0.2 (personal use)");
    expect(configFromEnv({ CONTACT_EMAIL: "me@example.com" }).userAgent).toBe("DealScout/0.2 (personal use)");
    expect(configFromEnv({ CONTACT_EMAIL: "a@b.org" }).userAgent).toBe("DealScout/0.2 (personal use, contact a@b.org)");
  });

  it("never sleeps to retry inside a cron run", () => {
    expect(configFromEnv(env).errorRetryCount).toBe(0);
  });

  it("applies threshold and judge cap overrides", () => {
    const config = configFromEnv({ ...env, HIGH_THRESHOLD: "0.82", MAX_JUDGE_CALLS_PER_DAY: "50" });
    expect(config.thresholdsByEmbeddingModel["@cf/baai/bge-base-en-v1.5"]).toEqual({ high: 0.82, low: 0.6 });
    expect(config.maxJudgeCallsPerDay).toBe(50);
    expect(() => configFromEnv({ ...env, LOW_THRESHOLD: "0.9" })).toThrow(/LOW_THRESHOLD/);
    expect(() => configFromEnv({ ...env, MAX_JUDGE_CALLS_PER_RUN: "lots" })).toThrow(/must be a number/);
  });

  it("explains missing bindings and bad provider settings", () => {
    expect(() => buildDepsFromEnv(env)).toThrow(/D1 binding/);
    const withDb = { ...env, DB: db };
    expect(() => buildDepsFromEnv(withDb)).toThrow(/Workers AI binding/);
    const ai = { run: async () => ({}) };
    expect(() => buildDepsFromEnv({ ...withDb, AI: ai, LLM_PROVIDER: "openai" })).toThrow(/LLM_PROVIDER/);
    expect(() => buildDepsFromEnv({ ...withDb, AI: ai, LLM_PROVIDER: "anthropic" })).toThrow(/ANTHROPIC_API_KEY/);
    expect(buildDepsFromEnv({ ...withDb, AI: ai }).embedder.model).toBe("@cf/baai/bge-base-en-v1.5");
  });

  it("reports config problems over HTTP instead of crashing", async () => {
    const realWorker = createWorker(buildDepsFromEnv);
    const response = await realWorker.fetch(api("GET", "/api/status"), { ADMIN_TOKEN }, ctx);
    expect(response.status).toBe(500);
    expect(await response.text()).toMatch(/Configuration problem/);
  });
});
