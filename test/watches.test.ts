import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildConfig } from "../src/core/config";
import { listActiveWatches } from "../src/core/db/queries";
import { createWatch } from "../src/core/watches/createWatch";
import { parseCreateWatchInput, watchTools } from "../src/core/watches/watchTools";
import type { Clock } from "../src/core/types";
import { createFakeEmbedder } from "../src/local/fakeEmbedder";
import { openSqliteDatabase, type SqliteDatabase } from "../src/local/sqliteDatabase";
import { planWatchWithRules, createStubWatchPlanner } from "../src/local/stubWatchPlanner";
import { fixturesDir } from "./helpers";

const migrationsDir = path.join(fixturesDir, "..", "..", "migrations");
const fixedClock: Clock = {
  now() {
    return new Date("2026-10-26T12:00:00.000Z");
  },
  async sleep() {},
};

describe("stub watch planner", () => {
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

describe("watch tools", () => {
  it("defines create_watch, list_watches and delete_watch", () => {
    const toolNames = watchTools.map((tool) => tool.name);
    expect(toolNames).toEqual(["create_watch", "list_watches", "delete_watch"]);
    const createSchema = watchTools[0]!.inputSchema as { required: string[]; properties: Record<string, unknown> };
    expect(createSchema.required).toEqual(["label", "intentDescription"]);
    expect(Object.keys(createSchema.properties)).toEqual(["label", "intentDescription", "maxPrice", "excludeTerms", "stores"]);
  });

  it("validates create_watch input", () => {
    expect(parseCreateWatchInput({ label: " Chargers ", intentDescription: "power banks", stores: ["Costco", " "] })).toEqual({
      label: "Chargers",
      intentDescription: "power banks",
      maxPrice: null,
      excludeTerms: [],
      stores: ["Costco"],
    });
    expect(() => parseCreateWatchInput({ label: "x" })).toThrow(/intentDescription/);
    expect(() => parseCreateWatchInput({ label: "x", intentDescription: "y", maxPrice: -5 })).toThrow(/maxPrice/);
    expect(() => parseCreateWatchInput({ label: "x", intentDescription: "y", excludeTerms: "used" })).toThrow(/excludeTerms/);
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

  it("plans, embeds the intent once and saves the watch with default thresholds", async () => {
    const config = buildConfig();
    const embedCalls: string[][] = [];
    const fakeEmbedder = createFakeEmbedder(config.embeddingDimensions);
    const countingEmbedder = {
      async embed(texts: string[]) {
        embedCalls.push(texts);
        return fakeEmbedder.embed(texts);
      },
    };
    const watch = await createWatch("local", "portable charger under $40, no cables", {
      db,
      planner: createStubWatchPlanner(),
      embedder: countingEmbedder,
      clock: fixedClock,
      config,
    });
    expect(embedCalls).toEqual([["portable charger"]]);
    expect(watch).toMatchObject({ label: "portable charger", maxPrice: 40, excludeTerms: ["cables"], active: true });
    expect(watch.highThreshold).toBe(config.defaultHighThreshold);
    expect(watch.lowThreshold).toBe(config.defaultLowThreshold);

    const [savedWatch] = await listActiveWatches(db);
    expect(savedWatch).toEqual(watch);
    expect(savedWatch!.intentEmbedding).toHaveLength(config.embeddingDimensions);
  });

  it("rejects an empty request", async () => {
    const config = buildConfig();
    const deps = { db, planner: createStubWatchPlanner(), embedder: createFakeEmbedder(), clock: fixedClock, config };
    await expect(createWatch("local", "   ", deps)).rejects.toThrow(/empty/);
  });
});

describe("fake embedder", () => {
  it("is deterministic, normalized and only sees word overlap", async () => {
    const embedder = createFakeEmbedder(256);
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
