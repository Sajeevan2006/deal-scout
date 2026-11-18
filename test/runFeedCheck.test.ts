import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildConfig } from "../src/core/config";
import { checkFetchGuard } from "../src/core/feed/fetchFeed";
import { getFeedState, insertWatch, listActiveWatches } from "../src/core/db/queries";
import { runFeedCheck, type FeedCheckDeps } from "../src/core/pipeline/runFeedCheck";
import type { BorderlineJudge } from "../src/core/ports/borderlineJudge";
import type { Embedder } from "../src/core/ports/embedder";
import type { FeedSource } from "../src/core/ports/feedSource";
import type { Notifier } from "../src/core/ports/notifier";
import type { Clock, DealAlert, FeedFetchResult, FeedState } from "../src/core/types";
import { createFileFeedSource } from "../src/local/fileFeedSource";
import { openSqliteDatabase, type SqliteDatabase } from "../src/local/sqliteDatabase";
import { createRecordingLogger, fixturesDir, realFeedPath, TEST_EMBEDDING_MODEL } from "./helpers";

const migrationsDir = path.join(fixturesDir, "..", "..", "migrations");
const config = buildConfig();
const BOSE_TITLE = "[Costco] Bose QuietComfort SE Headphones";

// Puts anything mentioning "bose" right on the watch vector, everything else far away
const keywordEmbedder: Embedder = {
  model: TEST_EMBEDDING_MODEL,
  async embed(texts) {
    const vectors: number[][] = [];
    for (const text of texts) {
      const mentionsBose = text.toLowerCase().includes("bose");
      vectors.push(mentionsBose ? [1, 0] : [0, 1]);
    }
    return vectors;
  },
};

const neverJudge: BorderlineJudge = {
  async isMatch() {
    return false;
  },
};

function recordingNotifier(): Notifier & { alerts: DealAlert[] } {
  const alerts: DealAlert[] = [];
  return {
    alerts,
    async sendAlert(alert) {
      alerts.push(alert);
    },
  };
}

function scriptedSource(results: FeedFetchResult[]): FeedSource & { statesSeen: FeedState[] } {
  const statesSeen: FeedState[] = [];
  return {
    feedUrl: config.feedUrl,
    isLive: true,
    statesSeen,
    async fetchLatest(state) {
      statesSeen.push(state);
      const next = results.shift();
      if (next === undefined) {
        throw new Error("No more scripted results");
      }
      return next;
    },
  };
}

const fixedClock: Clock = {
  now() {
    return new Date("2026-10-26T12:00:00.000Z");
  },
  async sleep() {},
};

let db: SqliteDatabase;
let notifier: ReturnType<typeof recordingNotifier>;

function depsWith(feedSource: FeedSource, overrides: Partial<FeedCheckDeps> = {}): FeedCheckDeps {
  return {
    db,
    feedSource,
    embedder: keywordEmbedder,
    judge: neverJudge,
    notifier,
    clock: fixedClock,
    logger: createRecordingLogger(),
    config,
    ...overrides,
  };
}

async function addBoseWatch(): Promise<number> {
  await db.prepare("INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)").bind("local", "Me", "2026-10-25").run();
  return insertWatch(db, {
    userId: "local",
    plan: { label: "noise cancelling headphones", intentDescription: "bose headphones", maxPrice: null, excludeTerms: [], stores: [] },
    intentEmbedding: [1, 0],
    embeddingModel: TEST_EMBEDDING_MODEL,
    highThreshold: 0.8,
    lowThreshold: 0.4,
    createdAt: "2026-10-25T00:00:00.000Z",
  });
}

async function countRows(table: "seen_posts" | "alerts"): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).first<{ total: number }>();
  return row?.total ?? 0;
}

beforeEach(() => {
  db = openSqliteDatabase(":memory:", migrationsDir);
  notifier = recordingNotifier();
});

afterEach(() => {
  db.close();
});

describe("runFeedCheck first run", () => {
  it("marks everything as seen without alerting by default", async () => {
    await addBoseWatch();
    const summary = await runFeedCheck(depsWith(createFileFeedSource(realFeedPath)));
    expect(summary).toMatchObject({ outcome: "ok", firstRun: true, fetched: 15, newPosts: 15, alerted: 0 });
    expect(notifier.alerts).toHaveLength(0);
    expect(await countRows("seen_posts")).toBe(15);
  });

  it("alerts on existing posts with alertExisting", async () => {
    await addBoseWatch();
    const summary = await runFeedCheck(depsWith(createFileFeedSource(realFeedPath)), { alertExisting: true });
    expect(summary).toMatchObject({ firstRun: true, matched: 1, alerted: 1 });
    expect(notifier.alerts).toHaveLength(1);
    const alert = notifier.alerts[0]!;
    expect(alert.post.title).toBe(BOSE_TITLE);
    expect(alert.store).toBe("Costco");
    expect(alert.priceUnknown).toBe(true);
    expect(alert.alertId).toBeGreaterThan(0);
  });

  it("alerts on genuinely new posts after the first run", async () => {
    await addBoseWatch();
    // The malformed fixture has 2 good posts that also appear in the real feed
    await runFeedCheck(depsWith(createFileFeedSource(path.join(fixturesDir, "malformed-entry-feed.xml"))));
    const summary = await runFeedCheck(depsWith(createFileFeedSource(realFeedPath)));
    expect(summary).toMatchObject({ firstRun: false, fetched: 15, newPosts: 13, alerted: 1 });
    expect(notifier.alerts[0]!.post.title).toBe(BOSE_TITLE);
  });
});

describe("runFeedCheck dedupe", () => {
  it("sends no duplicate alerts when run twice", async () => {
    await addBoseWatch();
    const feedSource = createFileFeedSource(realFeedPath);
    await runFeedCheck(depsWith(feedSource), { alertExisting: true });
    const secondSummary = await runFeedCheck(depsWith(feedSource), { alertExisting: true });
    expect(secondSummary).toMatchObject({ newPosts: 0, alerted: 0 });
    expect(notifier.alerts).toHaveLength(1);
    expect(await countRows("alerts")).toBe(1);
  });

  it("still sends no duplicate if a post somehow gets matched again", async () => {
    await addBoseWatch();
    const feedSource = createFileFeedSource(realFeedPath);
    await runFeedCheck(depsWith(feedSource), { alertExisting: true });
    // Forget seen posts so the same post is matched again, the alerts table must still stop it
    await db.prepare("DELETE FROM seen_posts").run();
    const secondSummary = await runFeedCheck(depsWith(feedSource), { alertExisting: true });
    expect(secondSummary).toMatchObject({ matched: 1, alerted: 0, duplicatesSkipped: 1 });
    expect(notifier.alerts).toHaveLength(1);
  });

  it("releases the alert claim when the notifier fails", async () => {
    await addBoseWatch();
    const failingNotifier: Notifier = {
      async sendAlert() {
        throw new Error("telegram down");
      },
    };
    const summary = await runFeedCheck(depsWith(createFileFeedSource(realFeedPath), { notifier: failingNotifier }), {
      alertExisting: true,
    });
    expect(summary).toMatchObject({ matched: 1, alerted: 0, failedAlerts: 1 });
    expect(await countRows("alerts")).toBe(0);
  });
});

describe("runFeedCheck fetch outcomes", () => {
  const okResult = (xml: string, lastModified: string | null): FeedFetchResult => ({
    outcome: "ok",
    xml,
    etag: null,
    lastModified,
    requestedAt: "2026-10-26T12:00:00.000Z",
  });

  it("does nothing on not_modified except record the request time", async () => {
    await addBoseWatch();
    const source = scriptedSource([{ outcome: "not_modified", requestedAt: "2026-10-26T12:00:00.000Z" }]);
    const summary = await runFeedCheck(depsWith(source));
    expect(summary).toMatchObject({ outcome: "not_modified", fetched: 0, newPosts: 0, alerted: 0 });
    expect(await countRows("seen_posts")).toBe(0);
    expect(notifier.alerts).toHaveLength(0);
    const state = await getFeedState(db, config.feedUrl);
    expect(state.lastStatus).toBe("not_modified");
    expect(state.lastCheckedAt).toBe("2026-10-26T12:00:00.000Z");
  });

  it("stops cleanly on blocked and the guard then refuses further live fetches", async () => {
    await addBoseWatch();
    const source = scriptedSource([
      {
        outcome: "blocked",
        status: 403,
        finalUrl: config.feedUrl,
        message: "HTTP 403",
        requestedAt: "2026-10-26T12:00:00.000Z",
      },
    ]);
    const summary = await runFeedCheck(depsWith(source));
    expect(summary.outcome).toBe("blocked");
    expect(summary.message).toContain("403");
    expect(summary.message).toContain(config.feedUrl);
    expect(await countRows("seen_posts")).toBe(0);
    expect(notifier.alerts).toHaveLength(0);

    const state = await getFeedState(db, config.feedUrl);
    expect(state.lastStatus).toBe("blocked");
    const muchLater = new Date("2026-10-27T12:00:00.000Z");
    expect(checkFetchGuard(state, muchLater, config.minFetchIntervalMs, false).allowed).toBe(false);
  });

  it("stores a back off time on rate_limited", async () => {
    const source = scriptedSource([{ outcome: "rate_limited", retryAfterSeconds: 900, requestedAt: "2026-10-26T12:00:00.000Z" }]);
    const summary = await runFeedCheck(depsWith(source));
    expect(summary).toMatchObject({ outcome: "rate_limited", retryInSeconds: 900 });
    const state = await getFeedState(db, config.feedUrl);
    expect(state.retryAfterUntil).toBe("2026-10-26T12:15:00.000Z");
  });

  it("returns early on a guard refusal without touching state", async () => {
    const source = scriptedSource([{ outcome: "guarded", message: "too soon", retryInSeconds: 30 }]);
    const summary = await runFeedCheck(depsWith(source));
    expect(summary).toMatchObject({ outcome: "guarded", retryInSeconds: 30 });
    const state = await getFeedState(db, config.feedUrl);
    expect(state.lastStatus).toBeNull();
  });

  it("saves Last-Modified after a good run and sends it back next time", async () => {
    const { readFileSync } = await import("node:fs");
    const xml = readFileSync(realFeedPath, "utf8");
    const source = scriptedSource([
      okResult(xml, "Sun, 25 Oct 2026 22:37:46 GMT"),
      { outcome: "not_modified", requestedAt: "2026-10-26T12:10:00.000Z" },
    ]);
    await runFeedCheck(depsWith(source));
    await runFeedCheck(depsWith(source));
    expect(source.statesSeen[0]!.lastModified).toBeNull();
    expect(source.statesSeen[1]!.lastModified).toBe("Sun, 25 Oct 2026 22:37:46 GMT");
    expect(source.statesSeen[1]!.lastCheckedAt).toBe("2026-10-26T12:00:00.000Z");
  });

  it("reports a parse failure as an error", async () => {
    const source = scriptedSource([okResult("<html>not a feed</html>", null)]);
    const summary = await runFeedCheck(depsWith(source));
    expect(summary.outcome).toBe("error");
    expect(summary.message).toMatch(/Could not parse feed/);
  });
});

describe("runFeedCheck matching details", () => {
  it("counts judge calls for borderline scores", async () => {
    await addBoseWatch();
    const borderlineEmbedder: Embedder = {
      model: TEST_EMBEDDING_MODEL,
      async embed(texts) {
        const vectors: number[][] = [];
        for (const text of texts) {
          vectors.push(text.includes("Bose") ? [0.6, 0.8] : [0, 1]);
        }
        return vectors;
      },
    };
    const judgeCalls: string[] = [];
    const countingJudge: BorderlineJudge = {
      async isMatch(post) {
        judgeCalls.push(post.title);
        return true;
      },
    };
    const summary = await runFeedCheck(
      depsWith(createFileFeedSource(realFeedPath), { embedder: borderlineEmbedder, judge: countingJudge }),
      { alertExisting: true },
    );
    expect(summary).toMatchObject({ judgeCalls: 1, alerted: 1 });
    expect(judgeCalls).toEqual([BOSE_TITLE]);
    expect(notifier.alerts[0]!.usedJudge).toBe(true);
  });

  it("ignores deactivated watches", async () => {
    const watchId = await addBoseWatch();
    await db.prepare("UPDATE watches SET active = 0 WHERE id = ?").bind(watchId).run();
    expect(await listActiveWatches(db)).toHaveLength(0);
    const summary = await runFeedCheck(depsWith(createFileFeedSource(realFeedPath)), { alertExisting: true });
    expect(summary.alerted).toBe(0);
  });
});

describe("runFeedCheck retries instead of losing posts", () => {
  const okResult = (xml: string): FeedFetchResult => ({
    outcome: "ok",
    xml,
    etag: null,
    lastModified: "Sun, 25 Oct 2026 22:37:46 GMT",
    requestedAt: "2026-10-26T12:00:00.000Z",
  });

  it("leaves posts unseen and drops the validators when embedding fails, then catches up", async () => {
    await addBoseWatch();
    const { readFileSync } = await import("node:fs");
    const xml = readFileSync(realFeedPath, "utf8");
    const failingEmbedder: Embedder = {
      model: TEST_EMBEDDING_MODEL,
      async embed() {
        throw new Error("Workers AI is down");
      },
    };
    const failed = await runFeedCheck(depsWith(scriptedSource([okResult(xml)]), { embedder: failingEmbedder }), { alertExisting: true });
    expect(failed.outcome).toBe("error");
    expect(failed.message).toMatch(/retried next run: Workers AI is down/);
    expect(await countRows("seen_posts")).toBe(0);
    const state = await getFeedState(db, config.feedUrl);
    expect(state.lastModified).toBeNull();
    expect(state.lastStatus).toBe("processing_error");

    const source = scriptedSource([okResult(xml)]);
    const recovered = await runFeedCheck(depsWith(source), { alertExisting: true });
    expect(source.statesSeen[0]!.lastModified).toBeNull();
    expect(recovered).toMatchObject({ outcome: "ok", newPosts: 15, alerted: 1 });
    expect(await countRows("seen_posts")).toBe(15);
  });

  it("keeps a post unseen when its alert can't be sent, and sends it once on the next run", async () => {
    await addBoseWatch();
    let telegramUp = false;
    const flakyNotifier: Notifier = {
      async sendAlert(alert) {
        if (!telegramUp) {
          throw new Error("telegram down");
        }
        notifier.alerts.push(alert);
      },
    };
    const feedSource = createFileFeedSource(realFeedPath);
    const first = await runFeedCheck(depsWith(feedSource, { notifier: flakyNotifier }), { alertExisting: true });
    expect(first).toMatchObject({ failedAlerts: 1, retryPostIds: [expect.stringContaining("t=")] });
    expect(await countRows("seen_posts")).toBe(14);

    telegramUp = true;
    const second = await runFeedCheck(depsWith(feedSource, { notifier: flakyNotifier }));
    expect(second).toMatchObject({ newPosts: 1, alerted: 1, failedAlerts: 0 });
    expect(notifier.alerts.map((alert) => alert.post.title)).toEqual([BOSE_TITLE]);
    expect(await countRows("seen_posts")).toBe(15);
  });
});

describe("runFeedCheck judge budget", () => {
  const borderlineEmbedder: Embedder = {
    model: TEST_EMBEDDING_MODEL,
    async embed(texts) {
      // Every post lands in the borderline band of the Bose watch
      return texts.map(() => [0.6, 0.8]);
    },
  };

  it("stops calling the judge when the per run cap is reached", async () => {
    await addBoseWatch();
    const judgeCalls: string[] = [];
    const yesJudge: BorderlineJudge = {
      async isMatch(post) {
        judgeCalls.push(post.title);
        return false;
      },
    };
    const cappedConfig = buildConfig({ maxJudgeCallsPerRun: 3 });
    const summary = await runFeedCheck(
      depsWith(createFileFeedSource(realFeedPath), { embedder: borderlineEmbedder, judge: yesJudge, config: cappedConfig }),
      { alertExisting: true },
    );
    expect(judgeCalls).toHaveLength(3);
    expect(summary).toMatchObject({ judgeCalls: 3, judgeSkipped: 12 });
    const counter = await db.prepare("SELECT value FROM app_state WHERE key = 'judge_calls:2026-10-26'").first<{ value: string }>();
    expect(counter?.value).toBe("3");
  });

  it("respects the daily cap across runs", async () => {
    await addBoseWatch();
    await db.prepare("INSERT INTO app_state (key, value, updated_at) VALUES ('judge_calls:2026-10-26', '299', 'x')").run();
    const summary = await runFeedCheck(depsWith(createFileFeedSource(realFeedPath), { embedder: borderlineEmbedder }), {
      alertExisting: true,
    });
    expect(summary.judgeCalls).toBe(1);
    expect(summary.judgeSkipped).toBe(14);
  });

  it("counts judge errors as no alert without failing the run", async () => {
    await addBoseWatch();
    const brokenJudge: BorderlineJudge = {
      async isMatch() {
        throw new Error("JSON Mode couldn't be met");
      },
    };
    const summary = await runFeedCheck(
      depsWith(createFileFeedSource(realFeedPath), { embedder: borderlineEmbedder, judge: brokenJudge, config: buildConfig({ maxJudgeCallsPerRun: 2 }) }),
      { alertExisting: true },
    );
    expect(summary).toMatchObject({ outcome: "ok", judgeErrors: 2, alerted: 0 });
    expect(await countRows("seen_posts")).toBe(15);
  });
});

describe("runFeedCheck housekeeping", () => {
  it("re-embeds watches made with another embedder before matching", async () => {
    await db.prepare("INSERT INTO users (id, display_name, created_at) VALUES ('local', 'Me', 'x')").run();
    await insertWatch(db, {
      userId: "local",
      plan: { label: "headphones", intentDescription: "bose headphones", maxPrice: null, excludeTerms: [], stores: [] },
      intentEmbedding: [0, 1],
      embeddingModel: "some/old-model",
      highThreshold: 0.8,
      lowThreshold: 0.4,
      createdAt: "2026-10-25T00:00:00.000Z",
    });
    const summary = await runFeedCheck(depsWith(createFileFeedSource(realFeedPath)), { alertExisting: true });
    expect(summary.alerted).toBe(1);
    const [watch] = await listActiveWatches(db);
    expect(watch!.embeddingModel).toBe(TEST_EMBEDDING_MODEL);
  });

  it("marks the first run done even when the feed is empty", async () => {
    const emptyFeed = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>x</title></feed>';
    const source = scriptedSource([
      { outcome: "ok", xml: emptyFeed, etag: null, lastModified: null, requestedAt: null },
      { outcome: "ok", xml: emptyFeed, etag: null, lastModified: null, requestedAt: null },
    ]);
    expect((await runFeedCheck(depsWith(source))).firstRun).toBe(true);
    expect((await runFeedCheck(depsWith(source))).firstRun).toBe(false);
  });

  it("deletes seen posts older than the retention window", async () => {
    await db
      .prepare("INSERT INTO seen_posts (id, title, link, published_at, seen_at) VALUES ('old', 't', 'l', NULL, '2026-08-01T00:00:00.000Z')")
      .run();
    await db.prepare("INSERT INTO app_state (key, value, updated_at) VALUES ('seen_initialized', '1', 'x')").run();
    await runFeedCheck(depsWith(createFileFeedSource(realFeedPath)));
    const old = await db.prepare("SELECT id FROM seen_posts WHERE id = 'old'").first();
    expect(old).toBeNull();
    expect(await countRows("seen_posts")).toBe(15);
  });

  it("stores the start of each post body for building eval data", async () => {
    await runFeedCheck(depsWith(createFileFeedSource(realFeedPath)));
    const row = await db.prepare("SELECT body_snippet FROM seen_posts WHERE title = ?").bind("[Costco] Ninja Dual Brew Coffee Maker").first<{ body_snippet: string }>();
    expect(row?.body_snippet).toBe("Found at Elgin Mills Costco");
  });
});
