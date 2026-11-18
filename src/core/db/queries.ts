import { decodeEmbedding, encodeEmbedding } from "../matching/vectors";
import type { Database } from "../ports/database";
import type { FeedState, FeedbackRating, FeedbackWithScore, Post, Watch, WatchPlan } from "../types";

// Every SQL statement lives here, always with ? placeholders.
// The Workers free plan allows 50 D1 queries per invocation, so per run work is done in
// bulk statements (json_each) rather than one query per row.
const SQL = {
  getFeedState: `
    SELECT feed_url, etag, last_modified, last_checked_at, last_status, retry_after_until
    FROM feed_state WHERE feed_url = ?`,
  recordFeedRequest: `
    INSERT INTO feed_state (feed_url, last_checked_at, last_status, retry_after_until)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(feed_url) DO UPDATE SET
      last_checked_at = COALESCE(excluded.last_checked_at, feed_state.last_checked_at),
      last_status = excluded.last_status,
      retry_after_until = excluded.retry_after_until`,
  saveFeedValidators: `
    INSERT INTO feed_state (feed_url, etag, last_modified)
    VALUES (?, ?, ?)
    ON CONFLICT(feed_url) DO UPDATE SET
      etag = excluded.etag,
      last_modified = excluded.last_modified`,
  unblockFeed: `UPDATE feed_state SET last_status = 'unblocked' WHERE feed_url = ? AND last_status = 'blocked'`,
  findSeenPostIds: `SELECT id FROM seen_posts WHERE id IN (SELECT value FROM json_each(?))`,
  insertSeenPosts: `
    INSERT OR IGNORE INTO seen_posts (id, title, link, published_at, body_snippet, seen_at)
    SELECT
      json_extract(value, '$.id'),
      json_extract(value, '$.title'),
      json_extract(value, '$.link'),
      json_extract(value, '$.publishedAt'),
      json_extract(value, '$.bodySnippet'),
      ?
    FROM json_each(?)`,
  pruneSeenPosts: `DELETE FROM seen_posts WHERE seen_at < ?`,
  pruneTelegramUpdates: `DELETE FROM telegram_updates WHERE received_at < ?`,
  pruneCounters: `DELETE FROM app_state WHERE key LIKE 'judge_calls:%' AND key < ?`,
  pruneRetryCounters: `DELETE FROM app_state WHERE (key LIKE 'retry:%' OR key LIKE 'pairing_attempts:%') AND updated_at < ?`,
  getAppState: `SELECT value FROM app_state WHERE key = ?`,
  setAppState: `
    INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  deleteAppState: `DELETE FROM app_state WHERE key = ?`,
  incrementCounter: `
    INSERT INTO app_state (key, value, updated_at) VALUES (?, CAST(CAST(? AS INTEGER) AS TEXT), ?)
    ON CONFLICT(key) DO UPDATE SET
      value = CAST(CAST(app_state.value AS INTEGER) + CAST(excluded.value AS INTEGER) AS TEXT),
      updated_at = excluded.updated_at`,
  ensureUser: `INSERT OR IGNORE INTO users (id, display_name, created_at) VALUES (?, ?, ?)`,
  insertWatch: `
    INSERT INTO watches (
      user_id, label, intent_description, intent_embedding, embedding_model, max_price,
      exclude_terms, stores, high_threshold, low_threshold, active, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    RETURNING id`,
  listActiveWatches: `SELECT * FROM watches WHERE active = 1 ORDER BY id`,
  listWatchesForUser: `SELECT * FROM watches WHERE user_id = ? ORDER BY id`,
  listActiveWatchesForUser: `SELECT * FROM watches WHERE user_id = ? AND active = 1 ORDER BY id`,
  getWatch: `SELECT * FROM watches WHERE id = ?`,
  deactivateWatch: `UPDATE watches SET active = 0 WHERE id = ? AND active = 1`,
  updateHighThreshold: `UPDATE watches SET high_threshold = ? WHERE id = ?`,
  updateThresholds: `UPDATE watches SET high_threshold = ?, low_threshold = ? WHERE id = ?`,
  updateWatchEmbedding: `
    UPDATE watches SET intent_embedding = ?, embedding_model = ?, high_threshold = ?, low_threshold = ?
    WHERE id = ?`,
  claimAlert: `
    INSERT INTO alerts (watch_id, post_id, score, used_judge, sent_at, embedding_model)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(watch_id, post_id) DO NOTHING
    RETURNING id`,
  releaseAlert: `DELETE FROM alerts WHERE id = ?`,
  getAlert: `SELECT id, watch_id, post_id, score, used_judge, sent_at FROM alerts WHERE id = ?`,
  insertFeedback: `INSERT INTO feedback (alert_id, rating, created_at) VALUES (?, ?, ?) RETURNING id`,
  // Latest rating per alert, so changing your mind doesn't double count. Only alerts scored by
  // the watch's current embedding model count, since scores from another model use another scale.
  listFeedbackForWatch: `
    SELECT a.id AS alert_id, f.rating AS rating, a.score AS score
    FROM alerts a
    JOIN feedback f ON f.alert_id = a.id
    WHERE a.watch_id = ? AND a.embedding_model = ?
      AND f.id = (SELECT MAX(f2.id) FROM feedback f2 WHERE f2.alert_id = a.id)
    ORDER BY a.id`,
  claimTelegramUpdate: `INSERT OR IGNORE INTO telegram_updates (update_id, received_at) VALUES (?, ?) RETURNING update_id`,
  listSeenPostsSince: `
    SELECT id, title, link, published_at, body_snippet, seen_at FROM seen_posts
    WHERE seen_at >= ? ORDER BY seen_at, id`,
} as const;

interface FeedStateRow {
  feed_url: string;
  etag: string | null;
  last_modified: string | null;
  last_checked_at: string | null;
  last_status: string | null;
  retry_after_until: string | null;
}

interface WatchRow {
  id: number;
  user_id: string;
  label: string;
  intent_description: string;
  intent_embedding: string;
  embedding_model: string;
  max_price: number | null;
  exclude_terms: string;
  stores: string;
  high_threshold: number;
  low_threshold: number;
  active: number;
  created_at: string;
}

export interface AlertRecord {
  id: number;
  watchId: number;
  postId: string;
  score: number;
  usedJudge: boolean;
  sentAt: string;
}

interface AlertRow {
  id: number;
  watch_id: number;
  post_id: string;
  score: number;
  used_judge: number;
  sent_at: string;
}

interface FeedbackRow {
  alert_id: number;
  rating: FeedbackRating;
  score: number;
}

function parseStringArray(json: string): string[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) {
    return [];
  }
  const strings: string[] = [];
  for (const item of parsed) {
    if (typeof item === "string") {
      strings.push(item);
    }
  }
  return strings;
}

function toWatch(row: WatchRow): Watch {
  return {
    id: row.id,
    userId: row.user_id,
    label: row.label,
    intentDescription: row.intent_description,
    intentEmbedding: decodeEmbedding(row.intent_embedding),
    embeddingModel: row.embedding_model,
    maxPrice: row.max_price,
    excludeTerms: parseStringArray(row.exclude_terms),
    stores: parseStringArray(row.stores),
    highThreshold: row.high_threshold,
    lowThreshold: row.low_threshold,
    active: row.active === 1,
    createdAt: row.created_at,
  };
}

// Feed state
export function emptyFeedState(feedUrl: string): FeedState {
  return { feedUrl, etag: null, lastModified: null, lastCheckedAt: null, lastStatus: null, retryAfterUntil: null };
}

export async function getFeedState(db: Database, feedUrl: string): Promise<FeedState> {
  const row = await db.prepare(SQL.getFeedState).bind(feedUrl).first<FeedStateRow>();
  if (!row) {
    return emptyFeedState(feedUrl);
  }
  return {
    feedUrl: row.feed_url,
    etag: row.etag,
    lastModified: row.last_modified,
    lastCheckedAt: row.last_checked_at,
    lastStatus: row.last_status,
    retryAfterUntil: row.retry_after_until,
  };
}

export async function recordFeedRequest(
  db: Database,
  feedUrl: string,
  lastCheckedAt: string | null,
  lastStatus: string,
  retryAfterUntil: string | null,
): Promise<void> {
  await db.prepare(SQL.recordFeedRequest).bind(feedUrl, lastCheckedAt, lastStatus, retryAfterUntil).run();
}

export async function saveFeedValidators(
  db: Database,
  feedUrl: string,
  etag: string | null,
  lastModified: string | null,
): Promise<void> {
  await db.prepare(SQL.saveFeedValidators).bind(feedUrl, etag, lastModified).run();
}

// Clears a "blocked" status so live fetches can run again. A 429 back off is left alone.
export async function unblockFeed(db: Database, feedUrl: string): Promise<boolean> {
  const result = await db.prepare(SQL.unblockFeed).bind(feedUrl).run();
  return result.meta.changes > 0;
}

// Seen posts
export async function findSeenPostIds(db: Database, postIds: string[]): Promise<Set<string>> {
  if (postIds.length === 0) {
    return new Set();
  }
  const { results } = await db.prepare(SQL.findSeenPostIds).bind(JSON.stringify(postIds)).all<{ id: string }>();
  const seenIds = new Set<string>();
  for (const row of results) {
    seenIds.add(row.id);
  }
  return seenIds;
}

// One statement for any number of posts
export async function insertSeenPosts(db: Database, posts: Post[], seenAt: string, bodyChars = 500): Promise<void> {
  if (posts.length === 0) {
    return;
  }
  const rows = posts.map((post) => ({
    id: post.id,
    title: post.title,
    link: post.link,
    publishedAt: post.publishedAt,
    bodySnippet: post.bodyText.slice(0, bodyChars),
  }));
  await db.prepare(SQL.insertSeenPosts).bind(seenAt, JSON.stringify(rows)).run();
}

export interface SeenPostRecord {
  id: string;
  title: string;
  link: string;
  publishedAt: string | null;
  bodySnippet: string;
  seenAt: string;
}

export async function listSeenPostsSince(db: Database, since: string): Promise<SeenPostRecord[]> {
  const { results } = await db
    .prepare(SQL.listSeenPostsSince)
    .bind(since)
    .all<{ id: string; title: string; link: string; published_at: string | null; body_snippet: string; seen_at: string }>();
  return results.map((row) => ({
    id: row.id,
    title: row.title,
    link: row.link,
    publishedAt: row.published_at,
    bodySnippet: row.body_snippet,
    seenAt: row.seen_at,
  }));
}

export interface PruneCutoffs {
  seenPostsBefore: string;
  telegramUpdatesBefore: string;
  retryCountersBefore: string;
  // judge_calls:YYYY-MM-DD keys older than this date are dropped
  countersBeforeDate: string;
}

export async function pruneOldRecords(db: Database, cutoffs: PruneCutoffs): Promise<void> {
  await db.prepare(SQL.pruneSeenPosts).bind(cutoffs.seenPostsBefore).run();
  await db.prepare(SQL.pruneTelegramUpdates).bind(cutoffs.telegramUpdatesBefore).run();
  await db.prepare(SQL.pruneCounters).bind(`judge_calls:${cutoffs.countersBeforeDate}`).run();
  await db.prepare(SQL.pruneRetryCounters).bind(cutoffs.retryCountersBefore).run();
}

// App state (small key/value store)
export const SEEN_INITIALIZED_KEY = "seen_initialized";
export const OWNER_CHAT_ID_KEY = "telegram_owner_chat_id";

export async function getAppState(db: Database, key: string): Promise<string | null> {
  const row = await db.prepare(SQL.getAppState).bind(key).first<{ value: string }>();
  return row ? row.value : null;
}

export async function setAppState(db: Database, key: string, value: string, updatedAt: string): Promise<void> {
  await db.prepare(SQL.setAppState).bind(key, value, updatedAt).run();
}

export async function deleteAppState(db: Database, key: string): Promise<void> {
  await db.prepare(SQL.deleteAppState).bind(key).run();
}

// Replaces COUNT(*) over seen_posts, which reads every row (D1 bills per row read)
export async function isSeenInitialized(db: Database): Promise<boolean> {
  return (await getAppState(db, SEEN_INITIALIZED_KEY)) !== null;
}

export async function markSeenInitialized(db: Database, updatedAt: string): Promise<void> {
  await setAppState(db, SEEN_INITIALIZED_KEY, "1", updatedAt);
}

export function retryCounterKey(postId: string): string {
  return `retry:${postId}`;
}

export function judgeCounterKey(now: Date): string {
  return `judge_calls:${now.toISOString().slice(0, 10)}`;
}

export async function getCounter(db: Database, key: string): Promise<number> {
  const value = await getAppState(db, key);
  const parsed = value === null ? 0 : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function incrementCounter(db: Database, key: string, amount: number, updatedAt: string): Promise<void> {
  await db.prepare(SQL.incrementCounter).bind(key, amount, updatedAt).run();
}

// Users and watches
export async function ensureUser(db: Database, userId: string, displayName: string, createdAt: string): Promise<void> {
  await db.prepare(SQL.ensureUser).bind(userId, displayName, createdAt).run();
}

export interface NewWatch {
  userId: string;
  plan: WatchPlan;
  intentEmbedding: ArrayLike<number>;
  embeddingModel: string;
  highThreshold: number;
  lowThreshold: number;
  createdAt: string;
}

export async function insertWatch(db: Database, newWatch: NewWatch): Promise<number> {
  const plan = newWatch.plan;
  const row = await db
    .prepare(SQL.insertWatch)
    .bind(
      newWatch.userId,
      plan.label,
      plan.intentDescription,
      encodeEmbedding(newWatch.intentEmbedding),
      newWatch.embeddingModel,
      plan.maxPrice,
      JSON.stringify(plan.excludeTerms),
      JSON.stringify(plan.stores),
      newWatch.highThreshold,
      newWatch.lowThreshold,
      newWatch.createdAt,
    )
    .first<{ id: number }>();
  if (!row) {
    throw new Error("Insert watch returned no id");
  }
  return row.id;
}

export async function listActiveWatches(db: Database): Promise<Watch[]> {
  const { results } = await db.prepare(SQL.listActiveWatches).all<WatchRow>();
  return results.map(toWatch);
}

export async function listWatchesForUser(db: Database, userId: string, activeOnly = false): Promise<Watch[]> {
  const sql = activeOnly ? SQL.listActiveWatchesForUser : SQL.listWatchesForUser;
  const { results } = await db.prepare(sql).bind(userId).all<WatchRow>();
  return results.map(toWatch);
}

export async function getWatch(db: Database, watchId: number): Promise<Watch | null> {
  const row = await db.prepare(SQL.getWatch).bind(watchId).first<WatchRow>();
  if (!row) {
    return null;
  }
  return toWatch(row);
}

export async function deactivateWatch(db: Database, watchId: number): Promise<boolean> {
  const result = await db.prepare(SQL.deactivateWatch).bind(watchId).run();
  return result.meta.changes > 0;
}

export async function updateWatchHighThreshold(db: Database, watchId: number, highThreshold: number): Promise<void> {
  await db.prepare(SQL.updateHighThreshold).bind(highThreshold, watchId).run();
}

export async function updateWatchThresholds(db: Database, watchId: number, highThreshold: number, lowThreshold: number): Promise<boolean> {
  const result = await db.prepare(SQL.updateThresholds).bind(highThreshold, lowThreshold, watchId).run();
  return result.meta.changes > 0;
}

// New embedding means new score scale, so thresholds go back to that model's defaults
export async function updateWatchEmbedding(
  db: Database,
  watchId: number,
  intentEmbedding: ArrayLike<number>,
  embeddingModel: string,
  highThreshold: number,
  lowThreshold: number,
): Promise<void> {
  await db
    .prepare(SQL.updateWatchEmbedding)
    .bind(encodeEmbedding(intentEmbedding), embeddingModel, highThreshold, lowThreshold, watchId)
    .run();
}

// Alerts
// Returns the new alert id, or null if this watch and post pair was already alerted
export async function claimAlert(
  db: Database,
  watchId: number,
  postId: string,
  score: number,
  usedJudge: boolean,
  sentAt: string,
  embeddingModel: string,
): Promise<number | null> {
  const usedJudgeFlag = usedJudge ? 1 : 0;
  const row = await db
    .prepare(SQL.claimAlert)
    .bind(watchId, postId, score, usedJudgeFlag, sentAt, embeddingModel)
    .first<{ id: number }>();
  if (!row) {
    return null;
  }
  return row.id;
}

export async function releaseAlert(db: Database, alertId: number): Promise<void> {
  await db.prepare(SQL.releaseAlert).bind(alertId).run();
}

export async function getAlert(db: Database, alertId: number): Promise<AlertRecord | null> {
  const row = await db.prepare(SQL.getAlert).bind(alertId).first<AlertRow>();
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    watchId: row.watch_id,
    postId: row.post_id,
    score: row.score,
    usedJudge: row.used_judge === 1,
    sentAt: row.sent_at,
  };
}

// Feedback
export async function insertFeedback(
  db: Database,
  alertId: number,
  rating: FeedbackRating,
  createdAt: string,
): Promise<number> {
  const row = await db.prepare(SQL.insertFeedback).bind(alertId, rating, createdAt).first<{ id: number }>();
  if (!row) {
    throw new Error("Insert feedback returned no id");
  }
  return row.id;
}

export async function listFeedbackForWatch(db: Database, watchId: number, embeddingModel: string): Promise<FeedbackWithScore[]> {
  const { results } = await db.prepare(SQL.listFeedbackForWatch).bind(watchId, embeddingModel).all<FeedbackRow>();
  const feedback: FeedbackWithScore[] = [];
  for (const row of results) {
    feedback.push({ alertId: row.alert_id, rating: row.rating, score: row.score });
  }
  return feedback;
}

// Telegram
// True the first time an update id is seen, false for a redelivery
export async function claimTelegramUpdate(db: Database, updateId: number, receivedAt: string): Promise<boolean> {
  const row = await db.prepare(SQL.claimTelegramUpdate).bind(updateId, receivedAt).first<{ update_id: number }>();
  return row !== null;
}
