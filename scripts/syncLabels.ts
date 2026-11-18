import path from "node:path";
import { collectedTitlesPath, labeledPostsPath, projectRoot } from "../src/local/localSetup";
import {
  DEFAULT_EVAL_WATCHES,
  readJsonFile,
  writeJsonFile,
  type CollectedTitle,
  type LabeledPost,
  type LabeledPostsFile,
} from "./labeledPosts";

// Adds any newly collected posts to labeled-posts.json as unreviewed, with no labels yet.
// Existing entries and your reviews are left alone (only a missing body snippet gets filled in).

const collectedTitles = await readJsonFile<CollectedTitle[]>(collectedTitlesPath, []);
if (collectedTitles.length === 0) {
  console.log("No collected titles. Run npm run titles:collect or npm run labels:pull first.");
  process.exit(0);
}

const labeledFile = await readJsonFile<LabeledPostsFile>(labeledPostsPath, { watches: DEFAULT_EVAL_WATCHES, posts: [] });
const labeledById = new Map<string, LabeledPost>();
for (const labeledPost of labeledFile.posts) {
  labeledById.set(labeledPost.id, labeledPost);
}

let addedCount = 0;
let bodiesFilled = 0;
for (const collected of collectedTitles) {
  const existing = labeledById.get(collected.id);
  if (existing !== undefined) {
    if (!existing.bodySnippet && collected.bodySnippet) {
      existing.bodySnippet = collected.bodySnippet;
      bodiesFilled += 1;
    }
    continue;
  }
  const entry: LabeledPost = { id: collected.id, title: collected.title, shouldMatch: [], reviewed: false };
  if (collected.bodySnippet) {
    entry.bodySnippet = collected.bodySnippet;
  }
  labeledFile.posts.push(entry);
  labeledById.set(entry.id, entry);
  addedCount += 1;
}

await writeJsonFile(labeledPostsPath, labeledFile);
console.log(
  `Added ${addedCount} unreviewed posts to ${path.relative(projectRoot, labeledPostsPath)} ` +
    `(${labeledFile.posts.length} total, ${bodiesFilled} bodies filled in).`,
);
