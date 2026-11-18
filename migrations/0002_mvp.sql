-- Works in SQLite and Cloudflare D1

-- Small key/value store: first run flag, Telegram owner chat, daily judge call counters
CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Watches made before this migration get re-embedded on the next check, since 'unknown'
-- never matches the configured embedding model
ALTER TABLE watches ADD COLUMN embedding_model TEXT NOT NULL DEFAULT 'unknown';

-- Start of each post body, so posts the bot has seen can become eval data (npm run labels:pull)
ALTER TABLE seen_posts ADD COLUMN body_snippet TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_seen_posts_seen_at ON seen_posts(seen_at);

-- Telegram can deliver the same update twice, this makes handling it idempotent
CREATE TABLE IF NOT EXISTS telegram_updates (
  update_id INTEGER PRIMARY KEY,
  received_at TEXT NOT NULL
);

-- A database that has already seen posts is past its first run
INSERT OR IGNORE INTO app_state (key, value, updated_at)
SELECT 'seen_initialized', '1', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (SELECT 1 FROM seen_posts);
