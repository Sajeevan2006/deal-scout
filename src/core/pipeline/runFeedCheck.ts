import type { DealScoutConfig } from "../config";
import {
  claimAlert,
  countSeenPosts,
  findSeenPostIds,
  getFeedState,
  insertSeenPost,
  listActiveWatches,
  recordFeedRequest,
  releaseAlert,
  saveFeedValidators,
} from "../db/queries";
import { parseFeed } from "../feed/parseFeed";
import { matchPosts } from "../matching/matchPosts";
import { extractTags } from "../matching/postText";
import type { BorderlineJudge } from "../ports/borderlineJudge";
import type { Database } from "../ports/database";
import type { Embedder } from "../ports/embedder";
import type { FeedSource } from "../ports/feedSource";
import type { Notifier } from "../ports/notifier";
import type { Clock, DealAlert, FeedFetchOutcome, FeedFetchResult, Logger, MatchDecision, Post } from "../types";

export interface FeedCheckDeps {
  db: Database;
  feedSource: FeedSource;
  embedder: Embedder;
  judge: BorderlineJudge;
  notifier: Notifier;
  clock: Clock;
  logger: Logger;
  config: DealScoutConfig;
}

export interface FeedCheckOptions {
  alertExisting?: boolean;
}

export interface FeedCheckSummary {
  outcome: FeedFetchOutcome;
  message: string;
  firstRun: boolean;
  fetched: number;
  newPosts: number;
  matched: number;
  alerted: number;
  duplicatesSkipped: number;
  failedAlerts: number;
  judgeCalls: number;
  // When the next live request makes sense (rate limit or guard)
  retryInSeconds: number | null;
  decisions: MatchDecision[];
}

function emptySummary(outcome: FeedFetchOutcome, message: string): FeedCheckSummary {
  return {
    outcome,
    message,
    firstRun: false,
    fetched: 0,
    newPosts: 0,
    matched: 0,
    alerted: 0,
    duplicatesSkipped: 0,
    failedAlerts: 0,
    judgeCalls: 0,
    retryInSeconds: null,
    decisions: [],
  };
}

// Saves guard info (time, status, back off) for any real request, before the response is processed
export async function recordFetchAttempt(
  db: Database,
  feedUrl: string,
  result: FeedFetchResult,
  config: DealScoutConfig,
): Promise<void> {
  if (result.outcome === "guarded") {
    return;
  }
  let retryAfterUntil: string | null = null;
  if (result.outcome === "rate_limited") {
    const backoffMs = rateLimitBackoffMs(result.retryAfterSeconds, config);
    const requestedMs = result.requestedAt ? Date.parse(result.requestedAt) : Date.now();
    retryAfterUntil = new Date(requestedMs + backoffMs).toISOString();
  }
  await recordFeedRequest(db, feedUrl, result.requestedAt, result.outcome, retryAfterUntil);
}

function rateLimitBackoffMs(retryAfterSeconds: number | null, config: DealScoutConfig): number {
  if (retryAfterSeconds === null) {
    return config.defaultRateLimitBackoffMs;
  }
  return Math.max(retryAfterSeconds * 1000, config.minFetchIntervalMs);
}

function summaryForFailedFetch(result: Exclude<FeedFetchResult, { outcome: "ok" }>, config: DealScoutConfig): FeedCheckSummary {
  if (result.outcome === "not_modified") {
    return emptySummary("not_modified", "Feed not modified (304), nothing to do.");
  }
  if (result.outcome === "guarded") {
    const summary = emptySummary("guarded", `Skipped: ${result.message}`);
    summary.retryInSeconds = result.retryInSeconds;
    return summary;
  }
  if (result.outcome === "rate_limited") {
    const backoffSeconds = Math.round(rateLimitBackoffMs(result.retryAfterSeconds, config) / 1000);
    const summary = emptySummary("rate_limited", `Rate limited by RFD (429). Backing off for ${backoffSeconds}s.`);
    summary.retryInSeconds = backoffSeconds;
    return summary;
  }
  if (result.outcome === "blocked") {
    return emptySummary(
      "blocked",
      `BLOCKED: status ${result.status}, final URL ${result.finalUrl} (${result.message}). Stopped, not working around it.`,
    );
  }
  return emptySummary("error", `Fetch failed: ${result.message}`);
}

function keepFirstOfEachId(posts: Post[]): Post[] {
  const seenIds = new Set<string>();
  const uniquePosts: Post[] = [];
  for (const post of posts) {
    if (seenIds.has(post.id)) {
      continue;
    }
    seenIds.add(post.id);
    uniquePosts.push(post);
  }
  return uniquePosts;
}

function buildAlert(alertId: number, decision: MatchDecision): DealAlert {
  return {
    alertId,
    post: decision.post,
    watch: decision.watch,
    score: decision.score,
    store: decision.postStore,
    price: decision.postPrice,
    priceUnknown: decision.priceUnknown,
    tags: extractTags(decision.post.title),
    usedJudge: decision.usedJudge,
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export async function runFeedCheck(deps: FeedCheckDeps, options: FeedCheckOptions = {}): Promise<FeedCheckSummary> {
  const { db, feedSource, logger, clock, config } = deps;
  const feedUrl = feedSource.feedUrl;

  // 1-2. Load state and fetch
  const feedState = await getFeedState(db, feedUrl);
  const fetchResult = await feedSource.fetchLatest(feedState);
  await recordFetchAttempt(db, feedUrl, fetchResult, config);
  // The fetcher already logged the outcome, callers print summary.message
  if (fetchResult.outcome !== "ok") {
    return summaryForFailedFetch(fetchResult, config);
  }

  // 3. Parse
  let parsedPosts: Post[];
  try {
    parsedPosts = parseFeed(fetchResult.xml, logger);
  } catch (error) {
    await recordFeedRequest(db, feedUrl, null, "parse_error", null);
    return emptySummary("error", `Could not parse feed: ${describeError(error)}`);
  }
  const fetchedPosts = keepFirstOfEachId(parsedPosts);

  // 4-5. Drop seen posts, remember the new ones
  const seenCountBefore = await countSeenPosts(db);
  const firstRun = seenCountBefore === 0;
  const fetchedIds: string[] = [];
  for (const post of fetchedPosts) {
    fetchedIds.push(post.id);
  }
  const alreadySeenIds = await findSeenPostIds(db, fetchedIds);
  const newPosts: Post[] = [];
  for (const post of fetchedPosts) {
    if (!alreadySeenIds.has(post.id)) {
      newPosts.push(post);
    }
  }
  const seenAt = clock.now().toISOString();
  for (const post of newPosts) {
    await insertSeenPost(db, post, seenAt);
  }

  const summary = emptySummary("ok", "");
  summary.firstRun = firstRun;
  summary.fetched = fetchedPosts.length;
  summary.newPosts = newPosts.length;

  if (firstRun && options.alertExisting !== true) {
    await saveFeedValidators(db, feedUrl, fetchResult.etag, fetchResult.lastModified);
    summary.message = `First run: marked ${newPosts.length} existing posts as seen without alerting (use --alert-existing to alert on them).`;
    return summary;
  }

  // 6-7. Match
  const watches = await listActiveWatches(db);
  const decisions = await matchPosts(newPosts, watches, {
    embedder: deps.embedder,
    judge: deps.judge,
    bodyChars: config.matchTextBodyChars,
  });
  summary.decisions = decisions;

  // 8. Alert, once per watch and post pair
  for (const decision of decisions) {
    if (decision.usedJudge) {
      summary.judgeCalls += 1;
    }
    if (!decision.shouldAlert) {
      continue;
    }
    summary.matched += 1;
    const sentAt = clock.now().toISOString();
    const alertId = await claimAlert(db, decision.watch.id, decision.post.id, decision.score, decision.usedJudge, sentAt);
    if (alertId === null) {
      summary.duplicatesSkipped += 1;
      continue;
    }
    try {
      await deps.notifier.sendAlert(buildAlert(alertId, decision));
      summary.alerted += 1;
    } catch (error) {
      summary.failedAlerts += 1;
      logger.error(`Failed to send alert for "${decision.post.title}": ${describeError(error)}`);
      await releaseAlert(db, alertId);
    }
  }

  // 9. Save validators only after everything above worked
  await saveFeedValidators(db, feedUrl, fetchResult.etag, fetchResult.lastModified);

  // 10. Summary
  summary.message =
    `Fetched ${summary.fetched}, new ${summary.newPosts}, matched ${summary.matched}, ` +
    `alerted ${summary.alerted}, judge calls ${summary.judgeCalls}` +
    (summary.duplicatesSkipped > 0 ? `, duplicates skipped ${summary.duplicatesSkipped}` : "") +
    (summary.failedAlerts > 0 ? `, failed alerts ${summary.failedAlerts}` : "");
  return summary;
}
