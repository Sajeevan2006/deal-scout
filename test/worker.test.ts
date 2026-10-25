import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildConfig, silentLogger, systemClock } from "../src/core/config";
import { listActiveWatches } from "../src/core/db/queries";
import { buildDepsFromEnv, createWorker, type WorkerDeps } from "../src/core/worker";
import { createConsoleNotifier } from "../src/local/consoleNotifier";
import { createFakeEmbedder } from "../src/local/fakeEmbedder";
import { createFileFeedSource } from "../src/local/fileFeedSource";
import { openSqliteDatabase, type SqliteDatabase } from "../src/local/sqliteDatabase";
import { createStubBorderlineJudge } from "../src/local/stubBorderlineJudge";
import { createStubWatchPlanner } from "../src/local/stubWatchPlanner";
import { fixturesDir, realFeedPath } from "./helpers";

const migrationsDir = path.join(fixturesDir, "..", "..", "migrations");

let db: SqliteDatabase;

function localDeps(): WorkerDeps {
  return {
    db,
    feedSource: createFileFeedSource(realFeedPath),
    embedder: createFakeEmbedder(),
    planner: createStubWatchPlanner(),
    judge: createStubBorderlineJudge(silentLogger),
    notifier: createConsoleNotifier(() => {}),
    clock: systemClock,
    logger: silentLogger,
    config: buildConfig(),
  };
}

beforeEach(() => {
  db = openSqliteDatabase(":memory:", migrationsDir);
});

afterEach(() => {
  db.close();
});

describe("worker shaped entry point", () => {
  const worker = createWorker(() => localDeps());

  it("creates a watch from a JSON POST", async () => {
    const request = new Request("https://example.test/watches", {
      method: "POST",
      body: JSON.stringify({ userId: "local", text: "air fryer under $100" }),
    });
    const response = await worker.fetch(request, {});
    expect(response.status).toBe(201);
    const body = (await response.json()) as { watch: Record<string, unknown> };
    expect(body.watch).toMatchObject({ label: "air fryer", maxPrice: 100 });
    expect(body.watch).not.toHaveProperty("intentEmbedding");
    expect(await listActiveWatches(db)).toHaveLength(1);
  });

  it("rejects other methods, bad JSON and missing fields", async () => {
    expect((await worker.fetch(new Request("https://example.test/"), {})).status).toBe(405);
    const badJson = new Request("https://example.test/", { method: "POST", body: "{nope" });
    expect((await worker.fetch(badJson, {})).status).toBe(400);
    const missingText = new Request("https://example.test/", { method: "POST", body: JSON.stringify({ userId: "local" }) });
    expect((await worker.fetch(missingText, {})).status).toBe(400);
  });

  it("runs a feed check on scheduled", async () => {
    await worker.scheduled({ cron: "*/10 * * * *", scheduledTime: Date.now() }, {});
    const row = await db.prepare("SELECT COUNT(*) AS total FROM seen_posts").first<{ total: number }>();
    expect(row?.total).toBe(15);
  });

  it("fails clearly when the real bindings are missing", () => {
    expect(() => buildDepsFromEnv({})).toThrow(/D1 binding/);
  });
});
