import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger, Post, Watch } from "../src/core/types";

export const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
export const realFeedPath = path.join(fixturesDir, "hot-deals-feed.xml");

export function readFixture(fileName: string): string {
  return readFileSync(path.join(fixturesDir, fileName), "utf8");
}

export interface RecordingLogger extends Logger {
  messages: { level: "info" | "warn" | "error"; message: string }[];
}

export function createRecordingLogger(): RecordingLogger {
  const messages: RecordingLogger["messages"] = [];
  return {
    messages,
    info(message) {
      messages.push({ level: "info", message });
    },
    warn(message) {
      messages.push({ level: "warn", message });
    },
    error(message) {
      messages.push({ level: "error", message });
    },
  };
}

export function makePost(overrides: Partial<Post> = {}): Post {
  return {
    id: "post-1",
    title: "[Amazon.ca] Anker 20000mAh Power Bank $29.99",
    link: "https://forums.redflagdeals.com/viewtopic.php?t=1",
    author: "someone",
    publishedAt: "2026-10-25T12:00:00.000Z",
    updatedAt: "2026-10-25T12:00:00.000Z",
    bodyText: "",
    ...overrides,
  };
}

export type WatchOverrides = Omit<Partial<Watch>, "intentEmbedding"> & { intentEmbedding?: ArrayLike<number> };

export const TEST_EMBEDDING_MODEL = "test/embedder";

export function makeWatch(overrides: WatchOverrides = {}): Watch {
  const { intentEmbedding, ...rest } = overrides;
  return {
    id: 1,
    userId: "local",
    label: "portable charger",
    intentDescription: "portable charger",
    intentEmbedding: Float32Array.from(intentEmbedding ?? [1, 0]),
    embeddingModel: TEST_EMBEDDING_MODEL,
    maxPrice: null,
    excludeTerms: [],
    stores: [],
    highThreshold: 0.8,
    lowThreshold: 0.4,
    active: true,
    createdAt: "2026-10-25T00:00:00.000Z",
    ...rest,
  };
}
