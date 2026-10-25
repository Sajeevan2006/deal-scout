import path from "node:path";
import { collectedTitlesPath, labeledPostsPath, projectRoot } from "../src/local/localSetup";
import {
  DEFAULT_EVAL_WATCHES,
  readJsonFile,
  writeJsonFile,
  type CollectedTitle,
  type LabeledPostsFile,
} from "./labeledPosts";

// Adds any newly collected titles to labeled-posts.json as unreviewed, with no labels yet.
// Existing entries and your reviews are left alone.

const collectedTitles = await readJsonFile<CollectedTitle[]>(collectedTitlesPath, []);
if (collectedTitles.length === 0) {
  console.log("No collected titles. Run npm run titles:collect first.");
  process.exit(0);
}

const labeledFile = await readJsonFile<LabeledPostsFile>(labeledPostsPath, { watches: DEFAULT_EVAL_WATCHES, posts: [] });
const labeledIds = new Set<string>();
for (const labeledPost of labeledFile.posts) {
  labeledIds.add(labeledPost.id);
}

let addedCount = 0;
for (const collected of collectedTitles) {
  if (labeledIds.has(collected.id)) {
    continue;
  }
  labeledFile.posts.push({ id: collected.id, title: collected.title, shouldMatch: [], reviewed: false });
  addedCount += 1;
}

await writeJsonFile(labeledPostsPath, labeledFile);
console.log(`Added ${addedCount} unreviewed posts to ${path.relative(projectRoot, labeledPostsPath)} (${labeledFile.posts.length} total).`);
