import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { consoleLogger } from "../src/core/config";
import { parseFeed } from "../src/core/feed/parseFeed";
import { capturesDir, collectedTitlesPath, projectRoot } from "../src/local/localSetup";
import { readJsonFile, writeJsonFile, type CollectedTitle } from "./labeledPosts";

// Oldest first, posts without a date at the end
function compareByPublishedAt(first: CollectedTitle, second: CollectedTitle): number {
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

if (!existsSync(capturesDir)) {
  console.log("No captures yet. Run npm run feed:capture first.");
  process.exit(0);
}

const captureFiles: string[] = [];
for (const fileName of await readdir(capturesDir)) {
  if (fileName.endsWith(".xml")) {
    captureFiles.push(fileName);
  }
}
captureFiles.sort();

// Merge into what's already collected, so deleting old captures loses nothing
const existingTitles = await readJsonFile<CollectedTitle[]>(collectedTitlesPath, []);
const titlesById = new Map<string, CollectedTitle>();
for (const collected of existingTitles) {
  titlesById.set(collected.id, collected);
}
const countBefore = titlesById.size;

for (const fileName of captureFiles) {
  const xml = await readFile(path.join(capturesDir, fileName), "utf8");
  let posts;
  try {
    posts = parseFeed(xml, consoleLogger);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Skipping ${fileName}: ${message}`);
    continue;
  }
  for (const post of posts) {
    if (titlesById.has(post.id)) {
      continue;
    }
    titlesById.set(post.id, { id: post.id, title: post.title, link: post.link, publishedAt: post.publishedAt });
  }
}

const mergedTitles = [...titlesById.values()];
mergedTitles.sort(compareByPublishedAt);
await writeJsonFile(collectedTitlesPath, mergedTitles);

const addedCount = titlesById.size - countBefore;
console.log(
  `Read ${captureFiles.length} captures. ${path.relative(projectRoot, collectedTitlesPath)} now has ${mergedTitles.length} posts (${addedCount} new).`,
);
