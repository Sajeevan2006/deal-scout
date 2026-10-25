-- Works in SQLite and Cloudflare D1

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS watches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  label TEXT NOT NULL,
  intent_description TEXT NOT NULL,
  intent_embedding TEXT NOT NULL,
  max_price REAL,
  exclude_terms TEXT NOT NULL DEFAULT '[]',
  stores TEXT NOT NULL DEFAULT '[]',
  high_threshold REAL NOT NULL,
  low_threshold REAL NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_watches_active ON watches(active);

CREATE TABLE IF NOT EXISTS seen_posts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  link TEXT NOT NULL,
  published_at TEXT,
  seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id INTEGER NOT NULL REFERENCES watches(id),
  post_id TEXT NOT NULL,
  score REAL NOT NULL,
  used_judge INTEGER NOT NULL DEFAULT 0,
  sent_at TEXT NOT NULL,
  UNIQUE (watch_id, post_id)
);

CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id INTEGER NOT NULL REFERENCES alerts(id),
  rating TEXT NOT NULL CHECK (rating IN ('up', 'down')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feed_state (
  feed_url TEXT PRIMARY KEY,
  etag TEXT,
  last_modified TEXT,
  last_checked_at TEXT,
  last_status TEXT,
  retry_after_until TEXT
);
