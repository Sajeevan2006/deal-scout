import path from "node:path";
import { parseArgs } from "node:util";
import { silentLogger, thresholdsFor } from "../src/core/config";
import { applyHardFilters } from "../src/core/matching/filters";
import { buildMatchText } from "../src/core/matching/postText";
import { cosineSimilarity } from "../src/core/matching/similarity";
import { createLlmJudge } from "../src/core/matching/llmJudge";
import type { Post, Watch, WatchPlan } from "../src/core/types";
import { createLlmWatchPlanner } from "../src/core/watches/llmWatchPlanner";
import { planWatchWithRules } from "../src/core/watches/rulePlanner";
import { createLocalEmbedder, createLocalLlms } from "../src/local/localAi";
import { evalPlansPath, labeledPostsPath, loadLocalConfig, projectRoot } from "../src/local/localSetup";
import { readJsonFile, writeJsonFile, type LabeledPost, type LabeledPostsFile } from "./labeledPosts";

// Measures matching quality on hand labeled posts and suggests thresholds.
//   npm run eval                          real embeddings if .env has Workers AI credentials
//   npm run eval -- --embedder fake       offline
//   npm run eval -- --planner rules|llm   how watch intents are written (llm is cached in data/eval-plans.json)
//   npm run eval -- --judge               also run the LLM judge on borderline scores
//   npm run eval -- --query-prefix        try bge's recommended prefix on watch intents
//   npm run eval -- --include-unreviewed  use draft labels too

// Below this many positive examples, precision and recall for a watch don't mean much
const MIN_POSITIVES = 3;
// bge v1.5's suggested instruction for short search queries
const BGE_QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

const { values: flags } = parseArgs({
  options: {
    "include-unreviewed": { type: "boolean", default: false },
    embedder: { type: "string", default: "auto" },
    planner: { type: "string" },
    judge: { type: "boolean", default: false },
    "query-prefix": { type: "boolean", default: false },
    "refresh-plans": { type: "boolean", default: false },
  },
});

const config = loadLocalConfig();
const labeledFile = await readJsonFile<LabeledPostsFile | null>(labeledPostsPath, null);
if (labeledFile === null) {
  console.log(`No ${path.relative(projectRoot, labeledPostsPath)} yet. Run npm run labels:pull (or titles:collect) and labels:sync first.`);
  process.exit(0);
}

const evalPosts: LabeledPost[] = labeledFile.posts.filter((post) => post.reviewed || flags["include-unreviewed"]);
const unreviewedCount = labeledFile.posts.filter((post) => !post.reviewed).length;

const embedderKind = flags.embedder as "auto" | "fake" | "workers-ai";
const embedder = createLocalEmbedder(embedderKind, config.embeddingDimensions);
const llms = createLocalLlms();
const plannerKind = flags.planner ?? (llms !== null ? "llm" : "rules");
if (plannerKind === "llm" && llms === null) {
  throw new Error("--planner llm needs Workers AI or Anthropic credentials in .env");
}
if (flags.judge && llms === null) {
  throw new Error("--judge needs Workers AI or Anthropic credentials in .env");
}

const defaults = thresholdsFor(config, embedder.model);
console.log(`Deal Scout eval: embedder ${embedder.model}, planner ${plannerKind === "llm" ? llms!.planner.name : "rules"}${flags.judge ? `, judge ${llms!.judge.name}` : ""}`);
console.log(`Labeled posts: ${labeledFile.posts.length}, unreviewed: ${unreviewedCount}, evaluating: ${evalPosts.length}`);
if (flags["include-unreviewed"]) {
  console.log("Including UNREVIEWED draft labels. Numbers below are not trustworthy yet.");
}
if (evalPosts.length === 0) {
  console.log('No reviewed posts. Set "reviewed": true in data/labeled-posts.json after checking the labels, or pass --include-unreviewed.');
  process.exit(0);
}

// Watch plans: LLM plans are cached so runs are comparable and cost nothing after the first
type PlanCache = Record<string, WatchPlan>;
const planCache = await readJsonFile<PlanCache>(evalPlansPath, {});
let planCacheChanged = false;
async function planFor(request: string): Promise<WatchPlan> {
  if (plannerKind !== "llm") {
    return planWatchWithRules(request);
  }
  const cacheKey = `${llms!.planner.name} :: ${request}`;
  const cached = planCache[cacheKey];
  if (cached && !flags["refresh-plans"]) {
    return cached;
  }
  const plan = await createLlmWatchPlanner(llms!.planner, { logger: silentLogger }).planWatch(request);
  planCache[cacheKey] = plan;
  planCacheChanged = true;
  return plan;
}

const plans: WatchPlan[] = [];
for (const spec of labeledFile.watches) {
  plans.push({ ...(await planFor(spec.request)), label: spec.label });
}
if (planCacheChanged) {
  await writeJsonFile(evalPlansPath, planCache);
}
const intentTexts = plans.map((plan) => (flags["query-prefix"] ? BGE_QUERY_PREFIX : "") + plan.intentDescription);
const intentVectors = await embedder.embed(intentTexts);
const watches: Watch[] = plans.map((plan, index) => ({
  ...plan,
  id: index + 1,
  userId: "eval",
  intentEmbedding: Float32Array.from(intentVectors[index]!),
  embeddingModel: embedder.model,
  highThreshold: defaults.high,
  lowThreshold: defaults.low,
  active: true,
  createdAt: new Date(0).toISOString(),
}));

const knownLabels = new Set(watches.map((watch) => watch.label));
const posts: Post[] = evalPosts.map((labeledPost) => ({
  id: labeledPost.id,
  title: labeledPost.title,
  link: "",
  author: null,
  publishedAt: null,
  updatedAt: null,
  bodyText: labeledPost.bodySnippet ?? "",
}));
const expected = new Map<string, Set<string>>();
for (const labeledPost of evalPosts) {
  expected.set(labeledPost.id, new Set(labeledPost.shouldMatch));
  for (const label of labeledPost.shouldMatch) {
    if (!knownLabels.has(label)) {
      console.warn(`Unknown watch label "${label}" on post ${labeledPost.id}`);
    }
  }
}
const postVectors = await embedder.embed(posts.map((post) => buildMatchText(post, config.matchTextBodyChars)));

interface Scored {
  post: Post;
  watch: Watch;
  score: number;
  passesFilters: boolean;
  shouldMatch: boolean;
}

const scored: Scored[] = [];
for (const [postIndex, post] of posts.entries()) {
  for (const watch of watches) {
    scored.push({
      post,
      watch,
      score: cosineSimilarity(postVectors[postIndex]!, watch.intentEmbedding),
      passesFilters: applyHardFilters(post, watch).passed,
      shouldMatch: expected.get(post.id)?.has(watch.label) ?? false,
    });
  }
}

function ratio(numerator: number, denominator: number): string {
  return denominator === 0 ? "  n/a" : `${((numerator / denominator) * 100).toFixed(0).padStart(4)}%`;
}

function summarizeScores(values: number[]): string {
  if (values.length === 0) {
    return "none";
  }
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  return `min ${sorted[0]!.toFixed(3)} median ${median.toFixed(3)} max ${sorted[sorted.length - 1]!.toFixed(3)} (n=${sorted.length})`;
}

// Decisions at the current default thresholds (judge optional)
const judge = flags.judge ? createLlmJudge(llms!.judge, { bodyChars: config.matchTextBodyChars }) : null;
let judgeCalls = 0;
async function alertsAtDefaults(item: Scored): Promise<boolean> {
  if (!item.passesFilters || item.score < defaults.low) {
    return false;
  }
  if (item.score >= defaults.high) {
    return true;
  }
  if (judge === null) {
    return false;
  }
  judgeCalls += 1;
  try {
    return await judge.isMatch(item.post, item.watch);
  } catch {
    return false;
  }
}

console.log(`\nAt the default thresholds for ${embedder.model}: high ${defaults.high}, low ${defaults.low}${judge ? " (judge decides in between)" : " (in between counts as no alert)"}`);
let totalTp = 0;
let totalFp = 0;
let totalFn = 0;
for (const watch of watches) {
  const items = scored.filter((item) => item.watch.id === watch.id);
  const positives = items.filter((item) => item.shouldMatch);
  const falsePositives: Scored[] = [];
  const falseNegatives: Scored[] = [];
  let truePositives = 0;
  for (const item of items) {
    const alerted = await alertsAtDefaults(item);
    if (alerted && item.shouldMatch) {
      truePositives += 1;
    } else if (alerted) {
      falsePositives.push(item);
    } else if (item.shouldMatch) {
      falseNegatives.push(item);
    }
  }
  totalTp += truePositives;
  totalFp += falsePositives.length;
  totalFn += falseNegatives.length;
  console.log(`\n[${watch.label}]  ${watch.maxPrice === null ? "" : `max $${watch.maxPrice}  `}intent: "${watch.intentDescription.slice(0, 140)}${watch.intentDescription.length > 140 ? "..." : ""}"`);
  console.log(
    `  positives ${positives.length}  alerts ${truePositives + falsePositives.length}  precision ${ratio(truePositives, truePositives + falsePositives.length)}  recall ${ratio(truePositives, positives.length)}`,
  );
  console.log(`  positive scores: ${summarizeScores(positives.map((item) => item.score))}`);
  console.log(`  negative scores: ${summarizeScores(items.filter((item) => !item.shouldMatch).map((item) => item.score))}`);
  if (positives.length < MIN_POSITIVES) {
    console.log(`  Only ${positives.length} positives (want ${MIN_POSITIVES}+). Collect more posts rather than inventing them.`);
  }
  for (const item of falsePositives) {
    console.log(`  FP ${item.score.toFixed(3)}  ${item.post.title}`);
  }
  for (const item of falseNegatives) {
    console.log(`  FN ${item.score.toFixed(3)}  ${item.post.title}${item.passesFilters ? "" : " (hard filtered)"}`);
  }
}
console.log(`\nOverall at defaults: precision ${ratio(totalTp, totalTp + totalFp)}  recall ${ratio(totalTp, totalTp + totalFn)}${judge ? `  judge calls ${judgeCalls}` : ""}`);

// Threshold sweep on raw scores (no judge): what alerting at score >= t would give
const candidates = scored.filter((item) => item.passesFilters);
const totalPositives = scored.filter((item) => item.shouldMatch).length;
console.log("\nThreshold sweep (alert when score >= t, hard filters applied, no judge):");
console.log("     t   alerts  precision  recall");
const sweep: { threshold: number; precision: number; recall: number }[] = [];
for (let threshold = 0.3; threshold <= 0.951; threshold += 0.025) {
  const alerted = candidates.filter((item) => item.score >= threshold);
  const truePositives = alerted.filter((item) => item.shouldMatch).length;
  const precision = alerted.length === 0 ? 1 : truePositives / alerted.length;
  const recall = totalPositives === 0 ? 0 : truePositives / totalPositives;
  sweep.push({ threshold, precision, recall });
  console.log(`  ${threshold.toFixed(3)}  ${String(alerted.length).padStart(6)}  ${ratio(truePositives, alerted.length).padStart(9)}  ${ratio(truePositives, totalPositives)}`);
}

if (totalPositives < MIN_POSITIVES * 2) {
  console.log(`\nToo few positives overall (${totalPositives}) to suggest thresholds. Keep collecting and labeling.`);
} else {
  // high: lowest t where alerts are rarely wrong; low: highest t that still keeps nearly every positive
  const highPick = sweep.find((row) => row.precision >= 0.9 && row.recall > 0);
  const lowPick = [...sweep].reverse().find((row) => row.recall >= 0.95);
  console.log("\nSuggested starting thresholds (check the FP/FN lists above before trusting them):");
  console.log(`  high ${highPick ? highPick.threshold.toFixed(3) : "(no threshold reaches 90% precision)"}`);
  console.log(`  low  ${lowPick ? lowPick.threshold.toFixed(3) : "(no threshold keeps 95% recall)"}`);
  console.log("  Set them with HIGH_THRESHOLD / LOW_THRESHOLD in wrangler.toml (new watches) or npm run remote -- thresholds <id> <high> <low>.");
}
