import type { FeedFetchResult, FeedState } from "../types";

export interface FeedSource {
  // Key for the feed_state row (live URL, or a file:// path for captures)
  readonly feedUrl: string;
  readonly isLive: boolean;
  fetchLatest(state: FeedState): Promise<FeedFetchResult>;
}
