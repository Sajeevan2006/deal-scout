import { defaultConfig, type ThresholdTuningConfig } from "../config";
import type { FeedbackWithScore, Watch } from "../types";

export interface ThresholdSuggestion {
  highThreshold: number;
  changed: boolean;
  reason: string;
}

function roundThreshold(value: number): number {
  return Math.round(value * 1000) / 1000;
}

// Rule: with enough thumbs down near or under the high threshold, raise it just above
// the highest of those scores. Capped at a max, never below a floor, never lowered.
export function suggestThreshold(
  watch: Pick<Watch, "highThreshold">,
  feedbackWithScores: FeedbackWithScore[],
  tuning: ThresholdTuningConfig = defaultConfig.thresholdTuning,
): ThresholdSuggestion {
  const currentThreshold = watch.highThreshold;
  const flooredCurrent = Math.max(currentThreshold, tuning.minHighThreshold);
  const nearMissCutoff = currentThreshold + tuning.margin;

  const nearMissDownScores: number[] = [];
  for (const feedback of feedbackWithScores) {
    if (feedback.rating === "down" && feedback.score < nearMissCutoff) {
      nearMissDownScores.push(feedback.score);
    }
  }

  if (nearMissDownScores.length < tuning.minDownVotes) {
    return {
      highThreshold: flooredCurrent,
      changed: flooredCurrent !== currentThreshold,
      reason: `${nearMissDownScores.length} thumbs down near the threshold, need ${tuning.minDownVotes} before changing it`,
    };
  }

  let highestDownScore = nearMissDownScores[0]!;
  for (const score of nearMissDownScores) {
    if (score > highestDownScore) {
      highestDownScore = score;
    }
  }

  let proposedThreshold = roundThreshold(highestDownScore + tuning.stepAboveHighestDown);
  if (proposedThreshold > tuning.maxHighThreshold) {
    proposedThreshold = tuning.maxHighThreshold;
  }
  if (proposedThreshold <= flooredCurrent) {
    return {
      highThreshold: flooredCurrent,
      changed: flooredCurrent !== currentThreshold,
      reason: `thumbs down scores top out at ${highestDownScore.toFixed(3)}, already under the threshold (those came through the judge)`,
    };
  }
  return {
    highThreshold: proposedThreshold,
    changed: true,
    reason: `${nearMissDownScores.length} thumbs down near the threshold, highest scored ${highestDownScore.toFixed(3)}`,
  };
}
