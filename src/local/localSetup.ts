import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildConfig, type DealScoutConfig } from "../core/config";
import { openSqliteDatabase, type SqliteDatabase } from "./sqliteDatabase";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const dataDir = path.join(projectRoot, "data");
export const capturesDir = path.join(dataDir, "captures");
export const databasePath = path.join(dataDir, "deal-scout.db");
export const migrationsDir = path.join(projectRoot, "migrations");
export const collectedTitlesPath = path.join(dataDir, "collected-titles.json");
export const labeledPostsPath = path.join(dataDir, "labeled-posts.json");
export const fixtureFeedPath = path.join(projectRoot, "test", "fixtures", "hot-deals-feed.xml");

export const DEFAULT_LOCAL_USER_ID = "local";
export const DEFAULT_LOCAL_USER_NAME = "Me";

// Captures keep their own ETag row so they never eat a 304 the checker needed
export function captureStateKey(feedUrl: string): string {
  return `${feedUrl}#capture`;
}

export function loadLocalConfig(): DealScoutConfig {
  const contact = process.env.DEAL_SCOUT_CONTACT;
  if (contact) {
    return buildConfig({ userAgent: `DealScout/0.1 (personal use, contact ${contact})` });
  }
  return buildConfig();
}

export function openLocalDatabase(filePath: string = databasePath): SqliteDatabase {
  return openSqliteDatabase(filePath, migrationsDir);
}

export function captureFileName(capturedAt: Date): string {
  const safeTimestamp = capturedAt.toISOString().replace(/[:.]/g, "-");
  return `feed-${safeTimestamp}.xml`;
}
