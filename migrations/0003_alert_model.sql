-- Works in SQLite and Cloudflare D1

-- Which embedding model scored each alert, so feedback from an older model's score scale
-- doesn't move thresholds for the current one
ALTER TABLE alerts ADD COLUMN embedding_model TEXT NOT NULL DEFAULT 'unknown';
