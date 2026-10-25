import type { Database } from "../ports/database";
import type { FeedState, FeedbackRating, FeedbackWithScore, Post, Watch, WatchPlan } from "../types";

// Every SQL statement lives here, always with ? placeholders
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
  countSeenPosts: `SELECT COUNT(*) AS total FROM seen_posts`,
  findSeenPostIds: `SELECT id FROM seen_posts WHERE id IN (SELECT value FROM json_each(?))`,
  insertSeenPost: `
    INSERT OR IGNORE INTO seen_posts (id, title, link, published_at, seen_at)
    VALUES (?, ?, ?, ?, ?)`,
  ensureUser: `INSERT OR IGNORE INTO users (id, display_name, created_at) VALUES (?, ?, ?)`,
  insertWatch: `
    INSERT INTO watches (
      user_id, label, intent_description, intent_embedding, max_price,
      exclude_terms, stores, high_threshold, low_threshold, active, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    RETURNING id`,
  listActiveWatches: `SELECT * FROM watches WHERE active = 1 ORDER BY id`,
  listWatchesForUser: `SELECT * FROM watches WHERE user_id = ? ORDER BY id`,
  getWatch: `SELECT * FROM watches WHERE id = ?`,
  deactivateWatch: `UPDATE watches SET active = 0 WHERE id = ? AND active = 1`,
  updateHighThreshold: `UPDATE watches SET high_threshold = ? WHERE id = ?`,
  claimAlert: `
    INSERT INTO alerts (watch_id, post_id, score, used_judge, sent_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(watch_id, post_id) DO NOTHING
    RETURNING id`,
  releaseAlert: `DELETE FROM alerts WHERE id = ?`,
  getAlert: `SELECT id, watch_id, post_id, score, used_judge, sent_at FROM alerts WHERE id = ?`,
  insertFeedback: `INSERT INTO feedback (alert_id, rating, created_at) VALUES (?, ?, ?) RETURNING id`,
  // Latest rating per alert, so changing your mind doesn't double count
  listFeedbackForWatch: `
    SELECT a.id AS alert_id, f.rating AS rating, a.score AS score
    FROM alerts a
    JOIN feedback f ON f.alert_id = a.id
    WHERE a.watch_id = ?
      AND f.id = (SELECT MAX(f2.id) FROM feedback f2 WHERE f2.alert_id = a.id)
    ORDER BY a.id`,
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

function parseNumberArray(json: string): number[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) {
    throw new Error("Stored embedding is not an array");
  }
  const numbers: number[] = [];
  for (const item of parsed) {
    if (typeof item !== "number") {
      throw new Error("Stored embedding has a non number value");
    }
    numbers.push(item);
  }
  return numbers;
}

function toWatch(row: WatchRow): Watch {
  return {
    id: row.id,
    userId: row.user_id,
    label: row.label,
    intentDescription: row.intent_description,
    intentEmbedding: parseNumberArray(row.intent_embedding),
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

// Seen posts
export async function countSeenPosts(db: Database): Promise<number> {
  const row = await db.prepare(SQL.countSeenPosts).first<{ total: number }>();
  if (!row) {
    return 0;
  }
  return row.total;
}

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

export async function insertSeenPost(db: Database, post: Post, seenAt: string): Promise<void> {
  await db.prepare(SQL.insertSeenPost).bind(post.id, post.title, post.link, post.publishedAt, seenAt).run();
}

// Users and watches
export async function ensureUser(db: Database, userId: string, displayName: string, createdAt: string): Promise<void> {
  await db.prepare(SQL.ensureUser).bind(userId, displayName, createdAt).run();
}

export interface NewWatch {
  userId: string;
  plan: WatchPlan;
  intentEmbedding: number[];
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
      JSON.stringify(newWatch.intentEmbedding),
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

export async function listWatchesForUser(db: Database, userId: string): Promise<Watch[]> {
  const { results } = await db.prepare(SQL.listWatchesForUser).bind(userId).all<WatchRow>();
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

// Alerts
// Returns the new alert id, or null if this watch and post pair was already alerted
export async function claimAlert(
  db: Database,
  watchId: number,
  postId: string,
  score: number,
  usedJudge: boolean,
  sentAt: string,
): Promise<number | null> {
  const usedJudgeFlag = usedJudge ? 1 : 0;
  const row = await db.prepare(SQL.claimAlert).bind(watchId, postId, score, usedJudgeFlag, sentAt).first<{ id: number }>();
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

export async function listFeedbackForWatch(db: Database, watchId: number): Promise<FeedbackWithScore[]> {
  const { results } = await db.prepare(SQL.listFeedbackForWatch).bind(watchId).all<FeedbackRow>();
  const feedback: FeedbackWithScore[] = [];
  for (const row of results) {
    feedback.push({ alertId: row.alert_id, rating: row.rating, score: row.score });
  }
  return feedback;
}
