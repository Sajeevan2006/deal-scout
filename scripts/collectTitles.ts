import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { consoleLogger } from "../src/core/config";
import { parseFeed } from "../src/core/feed/parseFeed";
import { capturesDir, collectedTitlesPath, projectRoot } from "../src/local/localSetup";
import { mergeCollectedTitles, readJsonFile, writeJsonFile, type CollectedTitle } from "./labeledPosts";

// Merges every saved capture into data/collected-titles.json, deduped by post id

if (!existsSync(capturesDir)) {
  console.log("No captures yet. Run npm run feed:capture first, or npm run labels:pull to use what the deployed bot saw.");
  process.exit(0);
}

const captureFiles = (await readdir(capturesDir)).filter((fileName) => fileName.endsWith(".xml")).sort();
const incoming: CollectedTitle[] = [];
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
    incoming.push({
      id: post.id,
      title: post.title,
      link: post.link,
      publishedAt: post.publishedAt,
      bodySnippet: post.bodyText.slice(0, 500),
    });
  }
}

// Merge into what's already collected, so deleting old captures loses nothing
const existing = await readJsonFile<CollectedTitle[]>(collectedTitlesPath, []);
const { merged, added } = mergeCollectedTitles(existing, incoming);
await writeJsonFile(collectedTitlesPath, merged);
console.log(
  `Read ${captureFiles.length} captures. ${path.relative(projectRoot, collectedTitlesPath)} now has ${merged.length} posts (${added} new).`,
);
