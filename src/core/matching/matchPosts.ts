import type { BorderlineJudge } from "../ports/borderlineJudge";
import type { Embedder } from "../ports/embedder";
import type { MatchDecision, Post, Watch } from "../types";
import { applyHardFilters } from "./filters";
import { buildMatchText } from "./postText";
import { cosineSimilarity } from "./similarity";

// Shared across one run, so borderline posts stop calling the judge once it runs out
export interface JudgeBudget {
  remaining: number;
  used: number;
}

export interface MatchDeps {
  embedder: Embedder;
  judge: BorderlineJudge;
  bodyChars?: number;
  // No budget means unlimited judge calls (eval and tests)
  judgeBudget?: JudgeBudget;
}

function formatScore(score: number): string {
  return score.toFixed(3);
}

async function decideForWatch(
  post: Post,
  postEmbedding: number[],
  watch: Watch,
  judge: BorderlineJudge,
  judgeBudget: JudgeBudget | undefined,
): Promise<MatchDecision> {
  const score = cosineSimilarity(postEmbedding, watch.intentEmbedding);
  const filterResult = applyHardFilters(post, watch);
  const decisionBase = {
    post,
    watch,
    score,
    postPrice: filterResult.postPrice,
    postStore: filterResult.postStore,
    priceUnknown: filterResult.postPrice === null,
  };

  if (!filterResult.passed) {
    return {
      ...decisionBase,
      shouldAlert: false,
      reason: `filtered_${filterResult.rejection}`,
      detail: filterResult.detail,
      usedJudge: false,
    };
  }
  if (score >= watch.highThreshold) {
    return {
      ...decisionBase,
      shouldAlert: true,
      reason: "above_high",
      detail: `score ${formatScore(score)} >= high ${formatScore(watch.highThreshold)}`,
      usedJudge: false,
    };
  }
  if (score < watch.lowThreshold) {
    return {
      ...decisionBase,
      shouldAlert: false,
      reason: "below_low",
      detail: `score ${formatScore(score)} < low ${formatScore(watch.lowThreshold)}`,
      usedJudge: false,
    };
  }

  if (judgeBudget !== undefined) {
    if (judgeBudget.remaining <= 0) {
      return {
        ...decisionBase,
        shouldAlert: false,
        reason: "judge_skipped",
        detail: `borderline score ${formatScore(score)}, judge budget used up`,
        usedJudge: false,
      };
    }
    judgeBudget.remaining -= 1;
    judgeBudget.used += 1;
  }
  let judgeSaidYes: boolean;
  try {
    judgeSaidYes = await judge.isMatch(post, watch);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...decisionBase,
      shouldAlert: false,
      reason: "judge_error",
      detail: `borderline score ${formatScore(score)}, judge failed: ${message}`,
      usedJudge: true,
    };
  }
  const borderlineDetail = `borderline score ${formatScore(score)}, judge said ${judgeSaidYes ? "yes" : "no"}`;
  return {
    ...decisionBase,
    shouldAlert: judgeSaidYes,
    reason: judgeSaidYes ? "judge_yes" : "judge_no",
    detail: borderlineDetail,
    usedJudge: true,
  };
}

// Embeds all posts in one batch, then scores every post against every watch
export async function matchPosts(posts: Post[], watches: Watch[], deps: MatchDeps): Promise<MatchDecision[]> {
  if (posts.length === 0 || watches.length === 0) {
    return [];
  }
  const matchTexts: string[] = [];
  for (const post of posts) {
    matchTexts.push(buildMatchText(post, deps.bodyChars));
  }
  const postEmbeddings = await deps.embedder.embed(matchTexts);
  if (postEmbeddings.length !== posts.length) {
    throw new Error(`Embedder returned ${postEmbeddings.length} vectors for ${posts.length} posts`);
  }

  const decisions: MatchDecision[] = [];
  for (const [postIndex, post] of posts.entries()) {
    const postEmbedding = postEmbeddings[postIndex]!;
    for (const watch of watches) {
      const decision = await decideForWatch(post, postEmbedding, watch, deps.judge, deps.judgeBudget);
      decisions.push(decision);
    }
  }
  return decisions;
}
