import { describe, expect, it } from "vitest";
import { cosineSimilarity } from "../src/core/matching/similarity";

describe("cosineSimilarity", () => {
  it("is 1 for identical direction, even when scaled", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1);
  });

  it("is 0 for orthogonal vectors and -1 for opposite ones", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 1], [-1, -1])).toBeCloseTo(-1);
  });

  it("matches a hand computed value", () => {
    // (1*4 + 2*5 + 3*6) / (sqrt(14) * sqrt(77))
    const expected = 32 / (Math.sqrt(14) * Math.sqrt(77));
    expect(cosineSimilarity([1, 2, 3], [4, 5, 6])).toBeCloseTo(expected, 10);
  });

  it("returns 0 when either vector is all zeros", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("throws a clear error when lengths differ", () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(/lengths differ \(2 vs 3\)/);
  });
});
