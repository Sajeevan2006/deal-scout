import { consoleLogger, systemClock, type DealScoutConfig } from "../core/config";
import { createHttpFeedSource } from "../core/feed/fetchFeed";
import type { FeedSource } from "../core/ports/feedSource";
import type { Logger } from "../core/types";

export interface LiveFeedSourceOptions {
  force?: boolean;
  logger?: Logger;
}

// Real RFD feed through Node's global fetch. All the polling rules live in core fetchFeed.
export function createLiveFeedSource(config: DealScoutConfig, options: LiveFeedSourceOptions = {}): FeedSource {
  const logger = options.logger ?? consoleLogger;
  const deps = {
    fetchFn: (url: string, init: RequestInit) => fetch(url, init),
    clock: systemClock,
    logger,
  };
  return createHttpFeedSource(config, deps, { force: options.force === true });
}
