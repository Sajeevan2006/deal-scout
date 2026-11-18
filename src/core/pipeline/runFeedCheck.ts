import type { DealScoutConfig } from "../config";
import {
  claimAlert,
  findSeenPostIds,
  getCounter,
  getFeedState,
  incrementCounter,
  insertSeenPosts,
  isSeenInitialized,
  judgeCounterKey,
  listActiveWatches,
  markSeenInitialized,
  pruneOldRecords,
  recordFeedRequest,
  releaseAlert,
  saveFeedValidators,
} from "../db/queries";
import { parseFeed } from "../feed/parseFeed";
import { matchPosts, type JudgeBudget } from "../matching/matchPosts";
import { extractTags } from "../matching/postText";
import type { BorderlineJudge } from "../ports/borderlineJudge";
import type { Database } from "../ports/database";
import type { Embedder } from "../ports/embedder";
import type { FeedSource } from "../ports/feedSource";
import type { Notifier } from "../ports/notifier";
import type { Clock, DealAlert, FeedFetchOutcome, FeedFetchResult, Logger, MatchDecision, Post } from "../types";
import { refreshStaleEmbeddings } from "../watches/refreshEmbeddings";

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
  judgeErrors: number;
  judgeSkipped: number;
  // Posts whose alert could not be sent. They stay unseen so the next run tries again.
  retryPostIds: string[];
  // When the next live request makes sense (rate limit or guard)
  retryInSeconds: number | null;
  decisions: MatchDecision[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

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
    judgeErrors: 0,
    judgeSkipped: 0,
    retryPostIds: [],
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

async function buildJudgeBudget(deps: FeedCheckDeps): Promise<{ budget: JudgeBudget; counterKey: string }> {
  const counterKey = judgeCounterKey(deps.clock.now());
  const usedToday = await getCounter(deps.db, counterKey);
  const leftToday = Math.max(0, deps.config.maxJudgeCallsPerDay - usedToday);
  return { budget: { remaining: Math.min(deps.config.maxJudgeCallsPerRun, leftToday), used: 0 }, counterKey };
}

// Matches new posts and sends alerts. Throws if embedding fails, so the caller can leave the
// posts unseen and retry them next run.
async function matchAndAlert(deps: FeedCheckDeps, newPosts: Post[], summary: FeedCheckSummary): Promise<void> {
  const { db, clock, logger, config } = deps;
  if (newPosts.length === 0) {
    return;
  }
  const activeWatches = await listActiveWatches(db);
  if (activeWatches.length === 0) {
    return;
  }
  const watches = await refreshStaleEmbeddings(db, activeWatches, deps.embedder, config, logger);
  const { budget, counterKey } = await buildJudgeBudget(deps);
  let decisions: MatchDecision[];
  try {
    decisions = await matchPosts(newPosts, watches, {
      embedder: deps.embedder,
      judge: deps.judge,
      bodyChars: config.matchTextBodyChars,
      judgeBudget: budget,
    });
  } finally {
    if (budget.used > 0) {
      await incrementCounter(db, counterKey, budget.used, clock.now().toISOString());
    }
  }
  summary.decisions = decisions;

  for (const decision of decisions) {
    if (decision.usedJudge) {
      summary.judgeCalls += 1;
    }
    if (decision.reason === "judge_error") {
      summary.judgeErrors += 1;
      logger.warn(`Judge failed for "${decision.post.title}" vs "${decision.watch.label}": ${decision.detail}`);
    }
    if (decision.reason === "judge_skipped") {
      summary.judgeSkipped += 1;
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
      logger.error(`Failed to send alert for "${decision.post.title}", will retry next run: ${describeError(error)}`);
      await releaseAlert(db, alertId);
      if (!summary.retryPostIds.includes(decision.post.id)) {
        summary.retryPostIds.push(decision.post.id);
      }
    }
  }
  if (summary.judgeSkipped > 0) {
    logger.warn(`Judge budget ran out, ${summary.judgeSkipped} borderline matches were skipped this run.`);
  }
}

function pruneCutoffs(now: Date, config: DealScoutConfig) {
  const nowMs = now.getTime();
  return {
    seenPostsBefore: new Date(nowMs - config.seenPostRetentionDays * DAY_MS).toISOString(),
    telegramUpdatesBefore: new Date(nowMs - 2 * DAY_MS).toISOString(),
    countersBeforeDate: new Date(nowMs - 7 * DAY_MS).toISOString().slice(0, 10),
  };
}

export async function runFeedCheck(deps: FeedCheckDeps, options: FeedCheckOptions = {}): Promise<FeedCheckSummary> {
  const { db, feedSource, logger, clock, config } = deps;
  const feedUrl = feedSource.feedUrl;

  // 1. Load state and fetch
  const feedState = await getFeedState(db, feedUrl);
  const fetchResult = await feedSource.fetchLatest(feedState);
  await recordFetchAttempt(db, feedUrl, fetchResult, config);
  // The fetcher already logged the outcome, callers print summary.message
  if (fetchResult.outcome !== "ok") {
    return summaryForFailedFetch(fetchResult, config);
  }

  // 2. Parse
  let parsedPosts: Post[];
  try {
    parsedPosts = parseFeed(fetchResult.xml, logger);
  } catch (error) {
    await recordFeedRequest(db, feedUrl, null, "parse_error", null);
    return emptySummary("error", `Could not parse feed: ${describeError(error)}`);
  }
  const fetchedPosts = keepFirstOfEachId(parsedPosts);

  // 3. Find the posts we haven't handled yet
  const alreadySeenIds = await findSeenPostIds(
    db,
    fetchedPosts.map((post) => post.id),
  );
  const newPosts = fetchedPosts.filter((post) => !alreadySeenIds.has(post.id));
  const firstRun = !(await isSeenInitialized(db));

  const summary = emptySummary("ok", "");
  summary.firstRun = firstRun;
  summary.fetched = fetchedPosts.length;
  summary.newPosts = newPosts.length;

  if (firstRun && options.alertExisting !== true) {
    const now = clock.now().toISOString();
    await insertSeenPosts(db, newPosts, now, config.storedBodyChars);
    await markSeenInitialized(db, now);
    await saveFeedValidators(db, feedUrl, fetchResult.etag, fetchResult.lastModified);
    summary.message = `First run: marked ${newPosts.length} existing posts as seen without alerting (use --alert-existing to alert on them).`;
    return summary;
  }

  // 4. Match and alert. Posts are only marked seen after this works, so a failed embedding
  // call means they get retried next run instead of being lost.
  try {
    await matchAndAlert(deps, newPosts, summary);
  } catch (error) {
    // Forget the validators so the next run gets the full feed instead of a 304
    await saveFeedValidators(db, feedUrl, null, null);
    await recordFeedRequest(db, feedUrl, null, "processing_error", null);
    summary.outcome = "error";
    summary.message = `Matching failed, these ${newPosts.length} posts will be retried next run: ${describeError(error)}`;
    logger.error(summary.message);
    return summary;
  }

  // 5. Remember the posts, then the validators, then tidy up. Posts whose alert failed stay
  // unseen, and the validators are dropped so the next run gets the full feed again.
  const now = clock.now();
  const handledPosts = newPosts.filter((post) => !summary.retryPostIds.includes(post.id));
  await insertSeenPosts(db, handledPosts, now.toISOString(), config.storedBodyChars);
  if (firstRun) {
    await markSeenInitialized(db, now.toISOString());
  }
  if (summary.retryPostIds.length > 0) {
    await saveFeedValidators(db, feedUrl, null, null);
  } else {
    await saveFeedValidators(db, feedUrl, fetchResult.etag, fetchResult.lastModified);
  }
  await pruneOldRecords(db, pruneCutoffs(now, config));

  // 6. Summary
  summary.message =
    `Fetched ${summary.fetched}, new ${summary.newPosts}, matched ${summary.matched}, ` +
    `alerted ${summary.alerted}, judge calls ${summary.judgeCalls}` +
    (summary.judgeErrors > 0 ? `, judge errors ${summary.judgeErrors}` : "") +
    (summary.judgeSkipped > 0 ? `, judge skipped ${summary.judgeSkipped}` : "") +
    (summary.duplicatesSkipped > 0 ? `, duplicates skipped ${summary.duplicatesSkipped}` : "") +
    (summary.failedAlerts > 0 ? `, failed alerts ${summary.failedAlerts}` : "");
  return summary;
}
