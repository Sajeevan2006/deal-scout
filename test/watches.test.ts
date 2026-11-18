import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildConfig, FAKE_EMBEDDING_MODEL, thresholdsFor } from "../src/core/config";
import { getWatch, insertWatch, listActiveWatches } from "../src/core/db/queries";
import type { Embedder } from "../src/core/ports/embedder";
import type { LlmClient } from "../src/core/ports/llm";
import type { Clock } from "../src/core/types";
import { createWatch } from "../src/core/watches/createWatch";
import { createLlmWatchPlanner } from "../src/core/watches/llmWatchPlanner";
import { refreshStaleEmbeddings } from "../src/core/watches/refreshEmbeddings";
import { createRuleWatchPlanner, planWatchWithRules } from "../src/core/watches/rulePlanner";
import { parseWatchPlan, WATCH_PLAN_SCHEMA } from "../src/core/watches/watchPlan";
import { createFakeEmbedder } from "../src/local/fakeEmbedder";
import { openSqliteDatabase, type SqliteDatabase } from "../src/local/sqliteDatabase";
import { createRecordingLogger, fixturesDir } from "./helpers";

const migrationsDir = path.join(fixturesDir, "..", "..", "migrations");
const fixedClock: Clock = {
  now() {
    return new Date("2026-10-26T12:00:00.000Z");
  },
  async sleep() {},
};

function scriptedLlm(answers: (unknown | Error)[]): LlmClient & { requests: { system: string; user: string }[] } {
  const requests: { system: string; user: string }[] = [];
  return {
    name: "test llm",
    requests,
    async generateJson(request) {
      requests.push({ system: request.system, user: request.user });
      const next = answers.shift();
      if (next instanceof Error) {
        throw next;
      }
      return next;
    },
  };
}

describe("rule watch planner", () => {
  it("pulls out max price and exclude terms", () => {
    expect(planWatchWithRules("portable charger under $40, no cables")).toEqual({
      label: "portable charger",
      intentDescription: "portable charger",
      maxPrice: 40,
      excludeTerms: ["cables"],
      stores: [],
    });
  });

  it("handles the eval style requests", () => {
    const gpuPlan = planWatchWithRules("desktop graphics card RTX 4070 family under $700");
    expect(gpuPlan).toMatchObject({ intentDescription: "desktop graphics card RTX 4070 family", maxPrice: 700, excludeTerms: [] });
    const headphonesPlan = planWatchWithRules("noise cancelling headphones");
    expect(headphonesPlan).toMatchObject({ intentDescription: "noise cancelling headphones", maxPrice: null, excludeTerms: [] });
  });

  it("splits several exclude terms and reads prices with cents and commas", () => {
    expect(planWatchWithRules("laptop not refurbished or used, max $1,299.99")).toMatchObject({
      intentDescription: "laptop",
      maxPrice: 1299.99,
      excludeTerms: ["refurbished", "used"],
    });
  });

  it("falls back to the whole request when nothing else is left", () => {
    expect(planWatchWithRules("no cables").intentDescription).toBe("no cables");
  });
});

describe("watch plan schema and validation", () => {
  it("requires every field and allows nothing extra, as structured output modes expect", () => {
    const schema = WATCH_PLAN_SCHEMA as { required: string[]; properties: Record<string, unknown>; additionalProperties: boolean };
    expect(Object.keys(schema.properties)).toEqual(["label", "intentDescription", "maxPrice", "excludeTerms", "stores"]);
    expect(schema.required).toEqual(Object.keys(schema.properties));
    expect(schema.additionalProperties).toBe(false);
  });

  it("validates and cleans a plan", () => {
    expect(parseWatchPlan({ label: " Chargers ", intentDescription: "power banks", stores: ["Costco", " ", "Costco"] })).toEqual({
      label: "Chargers",
      intentDescription: "power banks",
      maxPrice: null,
      excludeTerms: [],
      stores: ["Costco"],
    });
    expect(parseWatchPlan({ label: "x", intentDescription: "y", maxPrice: 0 }).maxPrice).toBeNull();
    expect(parseWatchPlan({ label: "x".repeat(80), intentDescription: "y" }).label).toHaveLength(60);
    expect(() => parseWatchPlan({ label: "x" })).toThrow(/intentDescription/);
    expect(() => parseWatchPlan({ label: "x", intentDescription: "y", maxPrice: -5 })).toThrow(/maxPrice/);
    expect(() => parseWatchPlan({ label: "x", intentDescription: "y", excludeTerms: "used" })).toThrow(/excludeTerms/);
  });
});

describe("LLM watch planner", () => {
  const richPlan = {
    label: "Portable charger",
    intentDescription: "Portable charger, power bank, battery pack for phones. Anker, Baseus, INIU.",
    maxPrice: 0,
    excludeTerms: [],
    stores: [],
  };

  it("uses the model's plan and keeps the rule planner's explicit price and excludes", async () => {
    const llm = scriptedLlm([richPlan]);
    const plan = await createLlmWatchPlanner(llm).planWatch("portable charger under $40, no cables");
    expect(plan).toEqual({ ...richPlan, maxPrice: 40, excludeTerms: ["cables"] });
    expect(llm.requests[0]!.user).toContain("portable charger under $40, no cables");
  });

  it("falls back to the rule planner when the model fails", async () => {
    const logger = createRecordingLogger();
    const plan = await createLlmWatchPlanner(scriptedLlm([new Error("JSON Mode couldn't be met")]), { logger }).planWatch("air fryer under $100");
    expect(plan).toEqual(planWatchWithRules("air fryer under $100"));
    expect(logger.messages[0]!.message).toMatch(/using the rule planner/);
  });

  it("falls back when the model's answer is not a valid plan", async () => {
    const plan = await createLlmWatchPlanner(scriptedLlm([{ label: "x" }])).planWatch("air fryer");
    expect(plan.intentDescription).toBe("air fryer");
  });
});

describe("createWatch", () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    db = openSqliteDatabase(":memory:", migrationsDir);
  });

  afterEach(() => {
    db.close();
  });

  it("plans, embeds the intent once and saves the watch with the model's thresholds", async () => {
    const config = buildConfig();
    const embedCalls: string[][] = [];
    const fakeEmbedder = createFakeEmbedder(config.embeddingDimensions);
    const countingEmbedder: Embedder = {
      model: fakeEmbedder.model,
      async embed(texts) {
        embedCalls.push(texts);
        return fakeEmbedder.embed(texts);
      },
    };
    const watch = await createWatch("local", "portable charger under $40, no cables", {
      db,
      planner: createRuleWatchPlanner(),
      embedder: countingEmbedder,
      clock: fixedClock,
      config,
    });
    expect(embedCalls).toEqual([["portable charger"]]);
    expect(watch).toMatchObject({ label: "portable charger", maxPrice: 40, excludeTerms: ["cables"], active: true });
    expect(watch.embeddingModel).toBe(FAKE_EMBEDDING_MODEL);
    expect(watch.highThreshold).toBe(thresholdsFor(config, FAKE_EMBEDDING_MODEL).high);
    expect(watch.lowThreshold).toBe(thresholdsFor(config, FAKE_EMBEDDING_MODEL).low);

    const [savedWatch] = await listActiveWatches(db);
    expect(savedWatch).toEqual(watch);
    expect(savedWatch!.intentEmbedding).toHaveLength(config.embeddingDimensions);
  });

  it("rejects an empty request", async () => {
    const config = buildConfig();
    const deps = { db, planner: createRuleWatchPlanner(), embedder: createFakeEmbedder(), clock: fixedClock, config };
    await expect(createWatch("local", "   ", deps)).rejects.toThrow(/empty/);
  });
});

describe("refreshStaleEmbeddings", () => {
  let db: SqliteDatabase;

  beforeEach(async () => {
    db = openSqliteDatabase(":memory:", migrationsDir);
    await db.prepare("INSERT INTO users (id, display_name, created_at) VALUES ('local', 'Me', '2026-10-25')").run();
  });

  afterEach(() => {
    db.close();
  });

  it("re-embeds watches from another model and resets their thresholds", async () => {
    const config = buildConfig();
    const plan = { label: "air fryer", intentDescription: "air fryer", maxPrice: null, excludeTerms: [], stores: [] };
    const base = { userId: "local", plan, createdAt: "2026-10-25T00:00:00.000Z", highThreshold: 0.9, lowThreshold: 0.5 };
    const staleId = await insertWatch(db, { ...base, intentEmbedding: [1, 0], embeddingModel: "old/model" });
    const currentId = await insertWatch(db, { ...base, intentEmbedding: [0, 1], embeddingModel: "@cf/baai/bge-base-en-v1.5" });
    const embedCalls: string[][] = [];
    const embedder: Embedder = {
      model: "@cf/baai/bge-base-en-v1.5",
      async embed(texts) {
        embedCalls.push(texts);
        return texts.map(() => [0.6, 0.8]);
      },
    };

    const refreshed = await refreshStaleEmbeddings(db, await listActiveWatches(db), embedder, config, createRecordingLogger());

    expect(embedCalls).toEqual([["air fryer"]]);
    const stale = refreshed.find((watch) => watch.id === staleId)!;
    expect(Array.from(stale.intentEmbedding)).toEqual([Math.fround(0.6), Math.fround(0.8)]);
    expect(stale).toMatchObject({ embeddingModel: "@cf/baai/bge-base-en-v1.5", highThreshold: 0.8, lowThreshold: 0.6 });
    expect((await getWatch(db, staleId))!.embeddingModel).toBe("@cf/baai/bge-base-en-v1.5");
    expect((await getWatch(db, currentId))!.highThreshold).toBe(0.9);
  });

  it("does nothing when every watch is current", async () => {
    const embedder: Embedder = {
      model: "m",
      async embed() {
        throw new Error("should not be called");
      },
    };
    expect(await refreshStaleEmbeddings(db, [], embedder, buildConfig(), createRecordingLogger())).toEqual([]);
  });
});

describe("fake embedder", () => {
  it("is deterministic, normalized and only sees word overlap", async () => {
    const embedder = createFakeEmbedder(256);
    expect(embedder.model).toBe(FAKE_EMBEDDING_MODEL);
    const [first, second, unrelated] = await embedder.embed(["Portable charger", "portable CHARGER!", "power bank"]);
    expect(first).toEqual(second);
    let squaredSum = 0;
    for (const value of first!) {
      squaredSum += value * value;
    }
    expect(squaredSum).toBeCloseTo(1);
    expect(unrelated).not.toEqual(first);
  });
});
