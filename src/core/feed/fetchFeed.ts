import type { DealScoutConfig } from "../config";
import type { FeedSource } from "../ports/feedSource";
import type { Clock, FeedFetchResult, FeedState, Logger } from "../types";

export type FetchFunction = (url: string, init: RequestInit) => Promise<Response>;

export interface FeedFetchDeps {
  fetchFn: FetchFunction;
  clock: Clock;
  logger: Logger;
}

export interface FeedFetchOptions {
  force?: boolean;
}

export type GuardDecision =
  | { allowed: true }
  | { allowed: false; message: string; retryInSeconds: number | null };

type LiveResult = Exclude<FeedFetchResult, { outcome: "guarded" }>;

interface AttemptResult {
  result: LiveResult;
  retryable: boolean;
}

const BLOCKED_STATUSES = new Set([401, 403, 451]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// Guard: refuses live requests that would break the polling rules
export function checkFetchGuard(
  state: FeedState,
  now: Date,
  minIntervalMs: number,
  force: boolean,
): GuardDecision {
  const nowMs = now.getTime();
  if (state.retryAfterUntil) {
    const retryAtMs = Date.parse(state.retryAfterUntil);
    if (!Number.isNaN(retryAtMs) && nowMs < retryAtMs) {
      const waitSeconds = Math.ceil((retryAtMs - nowMs) / 1000);
      return {
        allowed: false,
        message: `RFD rate limited us earlier. Backing off for ${waitSeconds}s more (--force does not override this).`,
        retryInSeconds: waitSeconds,
      };
    }
  }
  // The minimum gap always applies, --force or not
  if (state.lastCheckedAt) {
    const lastRequestMs = Date.parse(state.lastCheckedAt);
    const elapsedMs = nowMs - lastRequestMs;
    if (!Number.isNaN(lastRequestMs) && elapsedMs < minIntervalMs) {
      const waitSeconds = Math.ceil((minIntervalMs - elapsedMs) / 1000);
      return {
        allowed: false,
        message: `Last live request was ${Math.max(0, Math.round(elapsedMs / 1000))}s ago. Minimum gap is ${minIntervalMs / 1000}s, try again in ${waitSeconds}s.`,
        retryInSeconds: waitSeconds,
      };
    }
  }
  // --force only means "try once more after a block"
  if (state.lastStatus === "blocked" && !force) {
    return {
      allowed: false,
      message: "The last live fetch was blocked, so no automatic retries. Look into it first, then pass --force to try once.",
      retryInSeconds: null,
    };
  }
  return { allowed: true };
}

export function parseRetryAfter(headerValue: string | null, now: Date): number | null {
  if (!headerValue) {
    return null;
  }
  const trimmed = headerValue.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  const retryAtMs = Date.parse(trimmed);
  if (Number.isNaN(retryAtMs)) {
    return null;
  }
  const secondsUntil = Math.ceil((retryAtMs - now.getTime()) / 1000);
  return Math.max(0, secondsUntil);
}

function looksLikeAtomFeed(body: string): boolean {
  const start = body.slice(0, 2000).toLowerCase();
  return start.includes("<feed");
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // nothing useful to do here
  }
}

async function requestOnce(state: FeedState, config: DealScoutConfig, deps: FeedFetchDeps): Promise<AttemptResult> {
  const requestedAt = deps.clock.now().toISOString();
  const headers: Record<string, string> = {
    "User-Agent": config.userAgent,
    Accept: "application/atom+xml, application/xml;q=0.9, text/xml;q=0.8",
  };
  if (state.etag) {
    headers["If-None-Match"] = state.etag;
  }
  if (state.lastModified) {
    headers["If-Modified-Since"] = state.lastModified;
  }

  // Redirects are followed by hand so we never contact a host other than RFD
  let currentUrl = config.feedUrl;
  let redirectCount = 0;
  let response: Response | null = null;
  while (response === null) {
    let hopResponse: Response;
    try {
      hopResponse = await deps.fetchFn(currentUrl, { headers, redirect: "manual" });
    } catch (error) {
      return {
        result: { outcome: "error", status: null, message: `Network error: ${describeError(error)}`, requestedAt },
        retryable: true,
      };
    }
    if (!REDIRECT_STATUSES.has(hopResponse.status)) {
      response = hopResponse;
      break;
    }
    await discardBody(hopResponse);
    const location = hopResponse.headers.get("location");
    if (!location) {
      return {
        result: { outcome: "error", status: hopResponse.status, message: "Redirect without a Location header", requestedAt },
        retryable: false,
      };
    }
    let nextUrl: URL;
    try {
      nextUrl = new URL(location, currentUrl);
    } catch {
      return {
        result: { outcome: "error", status: hopResponse.status, message: `Redirect to an invalid URL: ${location}`, requestedAt },
        retryable: false,
      };
    }
    // Same host and still https, anything else is treated as a block
    if (nextUrl.hostname !== config.allowedFeedHost || nextUrl.protocol !== "https:") {
      return {
        result: {
          outcome: "blocked",
          status: hopResponse.status,
          finalUrl: nextUrl.href,
          message: `Redirected away from https://${config.allowedFeedHost}`,
          requestedAt,
        },
        retryable: false,
      };
    }
    if (redirectCount >= config.maxRedirects) {
      return {
        result: { outcome: "error", status: hopResponse.status, message: "Too many redirects", requestedAt },
        retryable: false,
      };
    }
    redirectCount += 1;
    currentUrl = nextUrl.href;
  }

  const status = response.status;
  if (status === 304) {
    await discardBody(response);
    return { result: { outcome: "not_modified", requestedAt }, retryable: false };
  }
  if (status === 429) {
    const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"), deps.clock.now());
    await discardBody(response);
    return { result: { outcome: "rate_limited", retryAfterSeconds, requestedAt }, retryable: false };
  }
  if (BLOCKED_STATUSES.has(status)) {
    await discardBody(response);
    return {
      result: { outcome: "blocked", status, finalUrl: currentUrl, message: `HTTP ${status}`, requestedAt },
      retryable: false,
    };
  }
  if (status >= 200 && status < 300) {
    const body = await response.text();
    if (!looksLikeAtomFeed(body)) {
      return {
        result: {
          outcome: "blocked",
          status,
          finalUrl: currentUrl,
          message: "Response was not an Atom feed (maybe a challenge page)",
          requestedAt,
        },
        retryable: false,
      };
    }
    return {
      result: {
        outcome: "ok",
        xml: body,
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
        requestedAt,
      },
      retryable: false,
    };
  }
  await discardBody(response);
  const serverError = status >= 500;
  return {
    result: { outcome: "error", status, message: `Unexpected HTTP ${status}`, requestedAt },
    retryable: serverError,
  };
}

function logOutcome(result: LiveResult, logger: Logger): void {
  if (result.outcome === "blocked") {
    logger.error(
      `BLOCKED by RFD: status ${result.status}, final URL ${result.finalUrl} (${result.message}). Stopping, not working around it.`,
    );
  } else if (result.outcome === "rate_limited") {
    const retryText = result.retryAfterSeconds === null ? "no Retry-After header" : `Retry-After ${result.retryAfterSeconds}s`;
    logger.warn(`Rate limited by RFD (429, ${retryText}). Backing off.`);
  } else if (result.outcome === "not_modified") {
    logger.info("Feed not modified since last check (304).");
  }
}

export async function fetchFeed(
  state: FeedState,
  config: DealScoutConfig,
  deps: FeedFetchDeps,
  options: FeedFetchOptions = {},
): Promise<FeedFetchResult> {
  const force = options.force === true;
  const guard = checkFetchGuard(state, deps.clock.now(), config.minFetchIntervalMs, force);
  if (!guard.allowed) {
    deps.logger.warn(`Fetch guard: ${guard.message}`);
    return { outcome: "guarded", message: guard.message, retryInSeconds: guard.retryInSeconds };
  }

  let retriesDone = 0;
  while (true) {
    const attempt = await requestOnce(state, config, deps);
    const result = attempt.result;
    logOutcome(result, deps.logger);
    const canRetry = result.outcome === "error" && attempt.retryable && retriesDone < config.errorRetryCount;
    if (!canRetry) {
      if (result.outcome === "error") {
        deps.logger.error(`Feed fetch failed: ${result.message}`);
      }
      return result;
    }
    const delayMs = config.errorRetryBaseDelayMs * 2 ** retriesDone;
    deps.logger.warn(
      `Feed fetch failed (${result.message}). Retry ${retriesDone + 1}/${config.errorRetryCount} in ${Math.round(delayMs / 1000)}s.`,
    );
    await deps.clock.sleep(delayMs);
    retriesDone += 1;
  }
}

export function createHttpFeedSource(
  config: DealScoutConfig,
  deps: FeedFetchDeps,
  options: FeedFetchOptions = {},
): FeedSource {
  return {
    feedUrl: config.feedUrl,
    isLive: true,
    fetchLatest(state) {
      return fetchFeed(state, config, deps, options);
    },
  };
}
