import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

// Shared shapes for data/collected-titles.json and data/labeled-posts.json

export interface CollectedTitle {
  id: string;
  title: string;
  link: string;
  publishedAt: string | null;
}

export interface EvalWatchSpec {
  label: string;
  request: string;
}

export interface LabeledPost {
  id: string;
  title: string;
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
