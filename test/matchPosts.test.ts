import { describe, expect, it } from "vitest";
import { matchPosts } from "../src/core/matching/matchPosts";
import type { BorderlineJudge } from "../src/core/ports/borderlineJudge";
import type { Embedder } from "../src/core/ports/embedder";
import { makePost, makeWatch } from "./helpers";

// Gives each post a vector at a chosen cosine score against the watch vector [1, 0]
function scoreEmbedder(scoresByTitle: Record<string, number>): Embedder & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async embed(texts) {
      calls.push(texts);
      const vectors: number[][] = [];
      for (const text of texts) {
        const title = text.split("\n")[0]!;
        const score = scoresByTitle[title] ?? 0;
        vectors.push([score, Math.sqrt(1 - score * score)]);
      }
      return vectors;
    },
  };
}

function recordingJudge(answer: boolean): BorderlineJudge & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async isMatch(post) {
      calls.push(post.title);
      return answer;
    },
  };
}

const watch = makeWatch({ highThreshold: 0.8, lowThreshold: 0.4, intentEmbedding: [1, 0] });
const highPost = makePost({ id: "high", title: "[Amazon.ca] Anker 20000mAh Power Bank $29" });
const lowPost = makePost({ id: "low", title: "[Costco] Ninja Dual Brew Coffee Maker" });
const borderlinePost = makePost({ id: "mid", title: "[Amazon.com] UGREEN Nexode 100W GaN USB-C Charger | $39.99" });
const embedder = () =>
  scoreEmbedder({
    [highPost.title]: 0.9,
    [lowPost.title]: 0.2,
    [borderlinePost.title]: 0.6,
  });

describe("matchPosts", () => {
  it("alerts above the high threshold without asking the judge", async () => {
    const judge = recordingJudge(false);
    const [decision] = await matchPosts([highPost], [watch], { embedder: embedder(), judge });
    expect(decision).toMatchObject({ shouldAlert: true, reason: "above_high", usedJudge: false });
    expect(decision!.score).toBeCloseTo(0.9);
    expect(judge.calls).toEqual([]);
  });

  it("skips below the low threshold without asking the judge", async () => {
    const judge = recordingJudge(true);
    const [decision] = await matchPosts([lowPost], [watch], { embedder: embedder(), judge });
    expect(decision).toMatchObject({ shouldAlert: false, reason: "below_low", usedJudge: false });
    expect(judge.calls).toEqual([]);
  });

  it("asks the judge in the borderline band and alerts only on yes", async () => {
    const yesJudge = recordingJudge(true);
    const [yesDecision] = await matchPosts([borderlinePost], [watch], { embedder: embedder(), judge: yesJudge });
    expect(yesDecision).toMatchObject({ shouldAlert: true, reason: "judge_yes", usedJudge: true });
    expect(yesJudge.calls).toEqual([borderlinePost.title]);

    const noJudge = recordingJudge(false);
    const [noDecision] = await matchPosts([borderlinePost], [watch], { embedder: embedder(), judge: noJudge });
    expect(noDecision).toMatchObject({ shouldAlert: false, reason: "judge_no", usedJudge: true });
  });

  it("treats a score exactly at high as an alert and exactly at low as borderline", async () => {
    const edgeWatch = makeWatch({ highThreshold: 0.6, lowThreshold: 0.2, intentEmbedding: [1, 0] });
    const judge = recordingJudge(false);
    const decisions = await matchPosts([borderlinePost, lowPost], [edgeWatch], { embedder: embedder(), judge });
    expect(decisions[0]!.reason).toBe("above_high");
    expect(decisions[1]!.reason).toBe("judge_no");
  });

  it("applies hard filters before the judge", async () => {
    const strictWatch = makeWatch({ highThreshold: 0.8, lowThreshold: 0.4, intentEmbedding: [1, 0], maxPrice: 20 });
    const judge = recordingJudge(true);
    const decisions = await matchPosts([highPost, borderlinePost], [strictWatch], { embedder: embedder(), judge });
    expect(decisions[0]).toMatchObject({ shouldAlert: false, reason: "filtered_over_max_price" });
    expect(decisions[1]).toMatchObject({ shouldAlert: false, reason: "filtered_over_max_price" });
    expect(judge.calls).toEqual([]);
  });

  it("marks matches with no price as priceUnknown", async () => {
    const lenientWatch = makeWatch({ highThreshold: 0.1, lowThreshold: 0.05, intentEmbedding: [1, 0], maxPrice: 50 });
    const [decision] = await matchPosts([lowPost], [lenientWatch], { embedder: embedder(), judge: recordingJudge(false) });
    expect(decision).toMatchObject({ shouldAlert: true, priceUnknown: true, postPrice: null });
  });

  it("embeds all posts in one batch and scores every post against every watch", async () => {
    const batchEmbedder = embedder();
    const secondWatch = makeWatch({ id: 2, label: "other", intentEmbedding: [0, 1] });
    const decisions = await matchPosts([highPost, lowPost, borderlinePost], [watch, secondWatch], {
      embedder: batchEmbedder,
      judge: recordingJudge(false),
    });
    expect(batchEmbedder.calls).toHaveLength(1);
    expect(batchEmbedder.calls[0]).toHaveLength(3);
    expect(decisions).toHaveLength(6);
  });

  it("does nothing when there are no posts or no watches", async () => {
    const emptyEmbedder = embedder();
    expect(await matchPosts([], [watch], { embedder: emptyEmbedder, judge: recordingJudge(true) })).toEqual([]);
    expect(await matchPosts([highPost], [], { embedder: emptyEmbedder, judge: recordingJudge(true) })).toEqual([]);
    expect(emptyEmbedder.calls).toHaveLength(0);
  });

  it("throws when the embedder returns the wrong number of vectors", async () => {
    const brokenEmbedder: Embedder = {
      async embed() {
        return [[1, 0]];
      },
    };
    await expect(matchPosts([highPost, lowPost], [watch], { embedder: brokenEmbedder, judge: recordingJudge(false) })).rejects.toThrow(
      /returned 1 vectors for 2 posts/,
    );
  });
});
