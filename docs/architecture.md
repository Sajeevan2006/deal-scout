# Architecture

## How a check works

1. Fetch the feed with `If-Modified-Since`. Anything other than a fresh feed (304, too soon, 429, block, error) ends
   the run. A cron run never sleeps to retry, the next run 10 minutes later does.
2. Parse the Atom entries and keep the posts not in `seen_posts`.
3. Re-embed any watch whose vector came from a different embedding model (after changing models).
4. Embed all new posts in one Workers AI call and score each against each active watch (cosine similarity).
5. Hard filters: excluded words, stores, max price.
6. Score ≥ `high` alerts, score < `low` skips, anything in between goes to the LLM judge (within per run and per day
   caps).
7. Each (watch, post) pair is claimed in `alerts` (unique constraint) before sending, so nothing is alerted twice.
8. Only after matching and sending worked are the posts marked seen and `Last-Modified` saved. If embedding fails or
   an alert can't be sent, those posts are retried next run instead of being lost.

On the very first run everything already in the feed is marked seen without alerting.

Creating a watch: the planner LLM writes a description (synonyms, brands, model names) plus a price limit, excluded
words and stores, validated against a schema. If the LLM fails, a rule based planner takes over, so creating a watch
always works. The description is embedded once and stored with the model that made it.

## Staying inside the free plan

| Limit (free plan) | What Deal Scout does |
| --- | --- |
| **10 ms CPU per invocation** | Purpose built Atom reader instead of an XML library, embeddings stored as base64 float32 (cheap to decode), per post and per watch filter work cached. `npm run bench`: about 6 ms worst case (15 new posts × 20 watches, cold), far less on a normal run with 0–3 new posts, near zero on a 304. Real numbers: dashboard → Workers → deal-scout → Metrics → CPU time. |
| **50 D1 queries per invocation** | Bulk statements (`json_each`) for seen posts. A typical run uses about 12 queries plus one per alert. |
| **D1 rows read per day** | No `COUNT(*)` over growing tables. Seen posts are pruned after 30 days. |
| **10,000 Workers AI neurons per day** | About 2,000 a day for one person with ~10 watches: embedding ~150 posts costs ~100 neurons, a judge call ~10, a new watch ~110. Judge calls are capped at 8 per run and 300 per day. Over the cap, borderline posts are skipped and the run says so. |
| **5 cron triggers** | One, every 10 minutes. |

If you ever outgrow it, Workers Paid ($5/month) raises the cron CPU limit to 30 seconds. Nothing else changes.

## Being a good citizen with the feed

- Only the Atom feed URL is ever requested, with an honest User-Agent (`DealScout/0.2 (personal use)`). The optional
  `CONTACT_EMAIL` var adds a contact to it.
- **2 minute guard**: a live request is refused if the last one was under 2 minutes ago. The cron runs every 10.
- **Conditional requests**: `Last-Modified` / `ETag` are sent back, so an unchanged feed is a cheap 304.
- **429**: `Retry-After` (seconds or a date) is respected even with `--force`. No header means a 15 minute back off.
- **Blocked**: a 401/403/451, a redirect to another host, or a 200 that isn't an Atom feed counts as blocked.
  Redirects are followed by hand, so the other host is never contacted. Fetching stops until you run
  `npm run remote -- unblock`. Nothing tries to get around a block.
- **Errors**: network errors and 5xx are left for the next cron run. The local CLI retries at most twice, starting at
  2 minutes.

## Project layout

- `src/core/` is the runtime agnostic pipeline: feed fetch and parse, matching, watches, feedback, D1 shaped queries.
- `src/adapters/` holds Workers AI, Claude, Telegram and notifier adapters (web standard APIs only).
- `src/worker/` is the Cloudflare Worker: cron, Telegram webhook, admin API.
- `src/local/` is the Node CLI with SQLite and offline stand ins.
- `scripts/` holds eval, labeling, capture, bench and the remote admin client.
- `migrations/` holds SQL that runs on both D1 and SQLite.

`tsconfig.core.json` typechecks `core`, `adapters` and `worker` without Node types, and `test/coreBoundary.test.ts`
checks their imports, so nothing Node only sneaks into the Worker.

## Known limitations

- The judge and planner run on open models by default. They're good, not perfect. Use 👎 and the eval.
- The judge only sees the title and the first 300 characters of the post.
- One owner per deployment by design. Someone else who wants alerts deploys their own copy.
