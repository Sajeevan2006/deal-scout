import { describe, expect, it } from "vitest";
import { suggestThreshold } from "../src/core/feedback/tuneThreshold";
import type { FeedbackWithScore } from "../src/core/types";

const tuning = {
  minDownVotes: 3,
  margin: 0.02,
  stepAboveHighestDown: 0.01,
  maxHighThreshold: 0.95,
  minHighThreshold: 0.3,
};

function down(score: number, alertId = 1): FeedbackWithScore {
  return { alertId, rating: "down", score };
}

function up(score: number, alertId = 1): FeedbackWithScore {
  return { alertId, rating: "up", score };
}

describe("suggestThreshold", () => {
  it("keeps the threshold with fewer than 3 thumbs down", () => {
    const suggestion = suggestThreshold({ highThreshold: 0.6 }, [down(0.61), down(0.6)], tuning);
    expect(suggestion).toMatchObject({ highThreshold: 0.6, changed: false });
  });

  it("raises it just above the highest thumbs down once there are 3", () => {
    const suggestion = suggestThreshold({ highThreshold: 0.6 }, [down(0.61), down(0.6), down(0.615)], tuning);
    expect(suggestion).toMatchObject({ highThreshold: 0.625, changed: true });
  });

  it("only counts thumbs down under the threshold plus the margin", () => {
    const feedback = [down(0.61), down(0.6), down(0.9), down(0.95)];
    const suggestion = suggestThreshold({ highThreshold: 0.6 }, feedback, tuning);
    expect(suggestion.changed).toBe(false);
  });

  it("ignores thumbs up", () => {
    const feedback = [up(0.61), up(0.6), up(0.605), down(0.61)];
    expect(suggestThreshold({ highThreshold: 0.6 }, feedback, tuning).changed).toBe(false);
  });

  it("caps the raise at the maximum", () => {
    const feedback = [down(0.95), down(0.951), down(0.96)];
    const suggestion = suggestThreshold({ highThreshold: 0.95 }, feedback, tuning);
    expect(suggestion.highThreshold).toBe(0.95);
    expect(suggestion.changed).toBe(false);
  });

  it("never lowers the threshold, even when all thumbs down scored well below it", () => {
    const feedback = [down(0.45), down(0.5), down(0.48)];
    const suggestion = suggestThreshold({ highThreshold: 0.6 }, feedback, tuning);
    expect(suggestion).toMatchObject({ highThreshold: 0.6, changed: false });
    expect(suggestion.reason).toMatch(/judge/);
  });

  it("lifts a threshold that sits below the floor", () => {
    const suggestion = suggestThreshold({ highThreshold: 0.2 }, [], tuning);
    expect(suggestion).toMatchObject({ highThreshold: 0.3, changed: true });
  });
});
