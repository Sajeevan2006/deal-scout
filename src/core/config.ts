import type { Clock, Logger } from "./types";

export interface ThresholdTuningConfig {
  minDownVotes: number;
  margin: number;
  stepAboveHighestDown: number;
  maxHighThreshold: number;
  minHighThreshold: number;
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
  defaultHighThreshold: number;
  defaultLowThreshold: number;
  embeddingDimensions: number;
  matchTextBodyChars: number;
  thresholdTuning: ThresholdTuningConfig;
}

export const MIN_FETCH_INTERVAL_MS = 2 * 60 * 1000;

export const defaultConfig: DealScoutConfig = {
  feedUrl: "https://forums.redflagdeals.com/feed/forum/9",
  allowedFeedHost: "forums.redflagdeals.com",
  userAgent: "DealScout/0.1 (personal use, contact me@example.com)",
  minFetchIntervalMs: MIN_FETCH_INTERVAL_MS,
  maxRedirects: 3,
  errorRetryCount: 2,
  errorRetryBaseDelayMs: MIN_FETCH_INTERVAL_MS,
  defaultRateLimitBackoffMs: 15 * 60 * 1000,
  checkIntervalMs: 10 * 60 * 1000,
  defaultHighThreshold: 0.6,
  defaultLowThreshold: 0.35,
  embeddingDimensions: 256,
  matchTextBodyChars: 300,
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
  return merged;
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
