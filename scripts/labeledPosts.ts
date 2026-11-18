import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

// Shared shapes for data/collected-titles.json and data/labeled-posts.json

export interface CollectedTitle {
  id: string;
  title: string;
  link: string;
  publishedAt: string | null;
  // Start of the post body, when known (captures and labels:pull have it)
  bodySnippet?: string;
}

export interface EvalWatchSpec {
  label: string;
  request: string;
}

export interface LabeledPost {
  id: string;
  title: string;
  bodySnippet?: string;
  shouldMatch: string[];
  reviewed: boolean;
  note?: string;
}

export interface LabeledPostsFile {
  watches: EvalWatchSpec[];
  posts: LabeledPost[];
}

export const DEFAULT_EVAL_WATCHES: EvalWatchSpec[] = [
  { label: "portable charger", request: "portable charger" },
  { label: "RTX 4070 graphics card", request: "desktop graphics card RTX 4070 family under $700" },
  { label: "noise cancelling headphones", request: "noise cancelling headphones" },
  { label: "air fryer", request: "air fryer" },
];

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  if (!existsSync(filePath)) {
    return fallback;
  }
  const text = await readFile(filePath, "utf8");
  return JSON.parse(text) as T;
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

// Oldest first, posts without a date at the end
export function compareByPublishedAt(first: CollectedTitle, second: CollectedTitle): number {
  if (first.publishedAt === second.publishedAt) {
    return first.id.localeCompare(second.id);
  }
  if (first.publishedAt === null) {
    return 1;
  }
  if (second.publishedAt === null) {
    return -1;
  }
  return first.publishedAt.localeCompare(second.publishedAt);
}

// Adds new posts to collected-titles.json and fills in missing bodies
export function mergeCollectedTitles(
  existing: CollectedTitle[],
  incoming: CollectedTitle[],
): { merged: CollectedTitle[]; added: number } {
  const byId = new Map<string, CollectedTitle>();
  for (const collected of existing) {
    byId.set(collected.id, collected);
  }
  let added = 0;
  for (const collected of incoming) {
    const current = byId.get(collected.id);
    if (current === undefined) {
      byId.set(collected.id, collected);
      added += 1;
    } else if (!current.bodySnippet && collected.bodySnippet) {
      byId.set(collected.id, { ...current, bodySnippet: collected.bodySnippet });
    }
  }
  const merged = [...byId.values()];
  merged.sort(compareByPublishedAt);
  return { merged, added };
}
