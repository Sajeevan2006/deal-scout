export interface Post {
  id: string;
  title: string;
  link: string;
  author: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
  bodyText: string;
}

// What a planner (stub now, LLM later) produces from a free text request
export interface WatchPlan {
  label: string;
  intentDescription: string;
  maxPrice: number | null;
  excludeTerms: string[];
  stores: string[];
}

export interface Watch extends WatchPlan {
  id: number;
  userId: string;
  intentEmbedding: number[];
  highThreshold: number;
  lowThreshold: number;
  active: boolean;
  createdAt: string;
}

export interface FeedState {
  feedUrl: string;
  etag: string | null;
  lastModified: string | null;
  // Time of the last live request, used by the fetch guard
  lastCheckedAt: string | null;
  lastStatus: string | null;
  // Set after a 429 so we back off until then
  retryAfterUntil: string | null;
}

export type FeedFetchResult =
  | {
      outcome: "ok";
      xml: string;
      etag: string | null;
      lastModified: string | null;
      requestedAt: string | null;
    }
  | { outcome: "not_modified"; requestedAt: string | null }
  | { outcome: "rate_limited"; retryAfterSeconds: number | null; requestedAt: string | null }
  | { outcome: "blocked"; status: number; finalUrl: string; message: string; requestedAt: string | null }
  | { outcome: "error"; status: number | null; message: string; requestedAt: string | null }
  // The fetch guard refused to make a live request
  | { outcome: "guarded"; message: string; retryInSeconds: number | null };

export type FeedFetchOutcome = FeedFetchResult["outcome"];

export type FilterRejection = "exclude_term" | "store" | "over_max_price";

export type DecisionReason =
  | "above_high"
  | "below_low"
  | "judge_yes"
  | "judge_no"
  | `filtered_${FilterRejection}`;

export interface MatchDecision {
  post: Post;
  watch: Watch;
  score: number;
  shouldAlert: boolean;
  reason: DecisionReason;
  detail: string;
  usedJudge: boolean;
  priceUnknown: boolean;
  postPrice: number | null;
  postStore: string | null;
}

export interface DealAlert {
  alertId: number;
  post: Post;
  watch: Watch;
  score: number;
  store: string | null;
  price: number | null;
  priceUnknown: boolean;
  tags: string[];
  usedJudge: boolean;
}

export type FeedbackRating = "up" | "down";

export interface FeedbackWithScore {
  alertId: number;
  rating: FeedbackRating;
  score: number;
}

export interface Clock {
  now(): Date;
  sleep(milliseconds: number): Promise<void>;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}
