import path from "node:path";
import { parseArgs } from "node:util";
import { silentLogger } from "../src/core/config";
import { matchPosts } from "../src/core/matching/matchPosts";
import type { MatchDecision, Post, Watch } from "../src/core/types";
import { createFakeEmbedder } from "../src/local/fakeEmbedder";
import { labeledPostsPath, loadLocalConfig, projectRoot } from "../src/local/localSetup";
import { createStubBorderlineJudge } from "../src/local/stubBorderlineJudge";
import { planWatchWithRules } from "../src/local/stubWatchPlanner";
import { readJsonFile, type LabeledPost, type LabeledPostsFile } from "./labeledPosts";

// Below this many positive examples, precision and recall for a watch don't mean much
const MIN_POSITIVES = 3;

const { values: flags } = parseArgs({ options: { "include-unreviewed": { type: "boolean", default: false } } });
const includeUnreviewed = flags["include-unreviewed"];

const config = loadLocalConfig();
const labeledFile = await readJsonFile<LabeledPostsFile | null>(labeledPostsPath, null);
if (labeledFile === null) {
  console.log(`No ${path.relative(projectRoot, labeledPostsPath)} yet. Run npm run titles:collect and npm run labels:sync first.`);
  process.exit(0);
}

const reviewedPosts: LabeledPost[] = [];
let unreviewedCount = 0;
for (const labeledPost of labeledFile.posts) {
  if (labeledPost.reviewed || includeUnreviewed) {
    reviewedPosts.push(labeledPost);
  }
  if (!labeledPost.reviewed) {
    unreviewedCount += 1;
  }
}

console.log("Deal Scout eval (fake embedder + stub judge, expect weak scores)");
console.log(`Labeled posts: ${labeledFile.posts.length}, still unreviewed: ${unreviewedCount}`);
if (includeUnreviewed) {
  console.log("Including UNREVIEWED draft labels (--include-unreviewed). Numbers below are not trustworthy yet.");
}
if (reviewedPosts.length === 0) {
  console.log("No reviewed posts to evaluate. Set \"reviewed\": true on entries in data/labeled-posts.json after checking their labels.");
  console.log("Or preview against the draft labels with: npm run eval -- --include-unreviewed");
  process.exit(0);
}

// Build in memory watches the same way watch:add would
const embedder = createFakeEmbedder(config.embeddingDimensions);
const judge = createStubBorderlineJudge(silentLogger);
const watches: Watch[] = [];
for (const [watchIndex, spec] of labeledFile.watches.entries()) {
  const plan = planWatchWithRules(spec.request);
  const [intentEmbedding] = await embedder.embed([plan.intentDescription]);
  watches.push({
    ...plan,
    label: spec.label,
    id: watchIndex + 1,
    userId: "eval",
    intentEmbedding: intentEmbedding!,
    highThreshold: config.defaultHighThreshold,
    lowThreshold: config.defaultLowThreshold,
    active: true,
    createdAt: new Date(0).toISOString(),
  });
}

const knownLabels = new Set<string>();
for (const watch of watches) {
  knownLabels.add(watch.label);
}

// Collected titles have no body, so the eval matches on titles alone
const posts: Post[] = [];
const labelsByPostId = new Map<string, Set<string>>();
for (const labeledPost of reviewedPosts) {
  posts.push({ id: labeledPost.id, title: labeledPost.title, link: "", author: null, publishedAt: null, updatedAt: null, bodyText: "" });
  labelsByPostId.set(labeledPost.id, new Set(labeledPost.shouldMatch));
  for (const label of labeledPost.shouldMatch) {
    if (!knownLabels.has(label)) {
      console.warn(`Unknown watch label "${label}" on post ${labeledPost.id}`);
    }
  }
}

const decisions = await matchPosts(posts, watches, { embedder, judge, bodyChars: config.matchTextBodyChars });
const decisionsByWatch = new Map<number, MatchDecision[]>();
for (const decision of decisions) {
  const watchDecisions = decisionsByWatch.get(decision.watch.id) ?? [];
  watchDecisions.push(decision);
  decisionsByWatch.set(decision.watch.id, watchDecisions);
}

function formatRatio(numerator: number, denominator: number): string {
  if (denominator === 0) {
    return "n/a";
  }
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function describeDecision(decision: MatchDecision): string {
  return `${decision.score.toFixed(3)}  ${decision.post.title}  (${decision.reason})`;
}

console.log(`Evaluating ${posts.length} posts against ${watches.length} watches (high ${config.defaultHighThreshold}, low ${config.defaultLowThreshold})`);
let totalTruePositives = 0;
let totalFalsePositives = 0;
let totalFalseNegatives = 0;

for (const watch of watches) {
  const falsePositives: MatchDecision[] = [];
  const falseNegatives: MatchDecision[] = [];
  let truePositives = 0;
  let positiveCount = 0;
  for (const decision of decisionsByWatch.get(watch.id) ?? []) {
    const expectedLabels = labelsByPostId.get(decision.post.id);
    const shouldMatch = expectedLabels?.has(watch.label) ?? false;
    if (shouldMatch) {
      positiveCount += 1;
    }
    if (shouldMatch && decision.shouldAlert) {
      truePositives += 1;
    } else if (!shouldMatch && decision.shouldAlert) {
      falsePositives.push(decision);
    } else if (shouldMatch && !decision.shouldAlert) {
      falseNegatives.push(decision);
    }
  }
  totalTruePositives += truePositives;
  totalFalsePositives += falsePositives.length;
  totalFalseNegatives += falseNegatives.length;

  const predictedCount = truePositives + falsePositives.length;
  console.log("");
  console.log(`[${watch.label}]  intent: "${watch.intentDescription}"${watch.maxPrice === null ? "" : `, max $${watch.maxPrice}`}`);
  console.log(
    `  positives ${positiveCount}  alerts ${predictedCount}  precision ${formatRatio(truePositives, predictedCount)}  recall ${formatRatio(truePositives, positiveCount)}`,
  );
  if (positiveCount < MIN_POSITIVES) {
    console.log(
      `  Not enough real positives yet (${positiveCount}, want at least ${MIN_POSITIVES}). Keep capturing for a few days rather than inventing posts.`,
    );
  }
  for (const decision of falsePositives) {
    console.log(`  FP ${describeDecision(decision)}`);
  }
  for (const decision of falseNegatives) {
    console.log(`  FN ${describeDecision(decision)}`);
  }
}

const totalPredicted = totalTruePositives + totalFalsePositives;
const totalPositives = totalTruePositives + totalFalseNegatives;
console.log("");
console.log(
  `Overall  precision ${formatRatio(totalTruePositives, totalPredicted)}  recall ${formatRatio(totalTruePositives, totalPositives)}  judge calls ${judge.callCount()}`,
);
