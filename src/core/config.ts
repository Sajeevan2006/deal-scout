import type { Clock, Logger } from "./types";

export interface ThresholdTuningConfig {
  minDownVotes: number;
  margin: number;
  stepAboveHighestDown: number;
  maxHighThreshold: number;
  minHighThreshold: number;
}

export interface ThresholdPair {
  high: number;
  low: number;
}

export interface DealScoutConfig {
  feedUrl: string;
  allowedFeedHost: string;
  userAgent: string;
  minFetchIntervalMs: number;
  maxRedirects: number;
  errorRetryCount: number;
  // Retries also respect the 2 minute rule, so the base delay starts there
  errorRetryBaseDelayMs: number;
  // Used when a 429 comes back without Retry-After
  defaultRateLimitBackoffMs: number;
  checkIntervalMs: number;
  // Used for embedding models that have no entry in thresholdsByEmbeddingModel
  defaultHighThreshold: number;
  defaultLowThreshold: number;
  // Each embedding model spreads its scores differently, so thresholds are per model.
  // Tune these with npm run eval.
  thresholdsByEmbeddingModel: Record<string, ThresholdPair>;
  embeddingDimensions: number;
  matchTextBodyChars: number;
  // Characters of the post body kept in seen_posts, for building eval data later
  storedBodyChars: number;
  // Caps on LLM judge calls, so a burst of posts can't use up the free AI allowance or the
  // per invocation subrequest limit. Over the cap, borderline posts are skipped.
  maxJudgeCallsPerRun: number;
  maxJudgeCallsPerDay: number;
  // seen_posts rows older than this are deleted. The feed only holds about a day of posts.
  seenPostRetentionDays: number;
  thresholdTuning: ThresholdTuningConfig;
}

export const MIN_FETCH_INTERVAL_MS = 2 * 60 * 1000;

// Name the local hashing embedder reports, so its vectors are never mixed with real ones
export const FAKE_EMBEDDING_MODEL = "local/fake-hash-256";

export const defaultConfig: DealScoutConfig = {
  feedUrl: "https://forums.redflagdeals.com/feed/forum/9",
  allowedFeedHost: "forums.redflagdeals.com",
  userAgent: "DealScout/0.2 (personal use)",
  minFetchIntervalMs: MIN_FETCH_INTERVAL_MS,
  maxRedirects: 3,
  errorRetryCount: 2,
  errorRetryBaseDelayMs: MIN_FETCH_INTERVAL_MS,
  defaultRateLimitBackoffMs: 15 * 60 * 1000,
  checkIntervalMs: 10 * 60 * 1000,
  defaultHighThreshold: 0.8,
  defaultLowThreshold: 0.6,
  thresholdsByEmbeddingModel: {
    // Word overlap only, scores run low
    [FAKE_EMBEDDING_MODEL]: { high: 0.6, low: 0.35 },
    // Starting guesses until the eval has enough labeled posts. High on purpose: the judge
    // handles the band in between, and feedback can only raise thresholds.
    "@cf/baai/bge-base-en-v1.5": { high: 0.8, low: 0.6 },
    "@cf/baai/bge-small-en-v1.5": { high: 0.8, low: 0.6 },
    "@cf/baai/bge-large-en-v1.5": { high: 0.8, low: 0.6 },
  },
  embeddingDimensions: 256,
  matchTextBodyChars: 300,
  storedBodyChars: 500,
  maxJudgeCallsPerRun: 8,
  maxJudgeCallsPerDay: 300,
  seenPostRetentionDays: 30,
  thresholdTuning: {
    minDownVotes: 3,
    margin: 0.02,
    stepAboveHighestDown: 0.01,
    maxHighThreshold: 0.95,
    minHighThreshold: 0.3,
  },
};

export function buildConfig(overrides: Partial<DealScoutConfig> = {}): DealScoutConfig {
  const merged = { ...defaultConfig, ...overrides };
  if (merged.minFetchIntervalMs < MIN_FETCH_INTERVAL_MS) {
    throw new Error(`minFetchIntervalMs must be at least ${MIN_FETCH_INTERVAL_MS}ms`);
  }
  if (merged.checkIntervalMs < MIN_FETCH_INTERVAL_MS) {
    throw new Error(`checkIntervalMs must be at least ${MIN_FETCH_INTERVAL_MS}ms`);
  }
  if (merged.maxJudgeCallsPerRun < 0 || merged.maxJudgeCallsPerDay < 0) {
    throw new Error("Judge call caps can't be negative");
  }
  return merged;
}

export function thresholdsFor(config: Pick<DealScoutConfig, "thresholdsByEmbeddingModel" | "defaultHighThreshold" | "defaultLowThreshold">, embeddingModel: string): ThresholdPair {
  const known = config.thresholdsByEmbeddingModel[embeddingModel];
  if (known) {
    return known;
  }
  return { high: config.defaultHighThreshold, low: config.defaultLowThreshold };
}

export const systemClock: Clock = {
  now() {
    return new Date();
  },
  sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  },
};

export const consoleLogger: Logger = {
  info(message) {
    console.log(message);
  },
  warn(message) {
    console.warn(message);
  },
  error(message) {
    console.error(message);
  },
};

export const silentLogger: Logger = {
  info() {},
  warn() {},
  error() {},
};
