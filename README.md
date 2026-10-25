# Deal Scout

> **Private personal project, for learning only.** It reads only the public RedFlagDeals Hot Deals Atom feed
> (`https://forums.redflagdeals.com/feed/forum/9`) at a low polling rate: never more than once every 2 minutes,
> every 10 minutes by default. It never scrapes forum pages. Not to be shared or used commercially.

Deal Scout watches the Hot Deals forum and alerts you when a new post matches something you asked for. Matching is
meant to be about intent, not keywords: "portable charger" should eventually match "[Amazon] Anker 20000mAh Power
Bank $29".

This is **phase 1**: the whole pipeline runs locally in TypeScript. The LLM, embedding, Telegram and Cloudflare
parts are interfaces with simple local placeholders, so they can be swapped in later without touching the core.

## Architecture

```
 npm run check / check:loop          (later: Cloudflare cron -> worker.scheduled)
        |
        v
 FeedSource ---> parseFeed ---> drop seen ---> matchPosts ---> alert dedupe ---> Notifier
 live or file    Atom -> Post   seen_posts       |             alerts table      console now,
 2 min guard                                     |                               Telegram later
 conditional GET                                 +-- Embedder (one batch per check)
                                                 +-- hard filters (excludes, store, max price)
                                                 +-- BorderlineJudge (in-between scores only)

 All state goes through Database (D1 shaped). SQLite now, D1 later.

 npm run watch:add -> createWatch -> WatchPlanner (stub now, LLM later) -> Embedder -> watches
```

How a check works:

1. Load the feed state (Last-Modified, ETag, last request time) from `feed_state`.
2. Fetch the feed through a `FeedSource`. Anything other than a fresh feed (304, guard refusal, 429, block, error) ends the run early with a clear message.
3. Parse the Atom entries into `Post`s and drop the ones already in `seen_posts`.
4. Record the new posts as seen.
5. Embed all new posts in one batch, score each against every active watch, apply hard filters, then decide:
   score >= `highThreshold` alerts, score < `lowThreshold` skips, anything in between goes to the `BorderlineJudge`.
6. For each alert, claim the (watch, post) pair in `alerts` (unique constraint), then send it. A pair is never alerted twice.
7. Save the new Last-Modified/ETag only after everything worked, then return a summary.

On the very first run (empty `seen_posts`) everything currently in the feed is marked seen without alerting,
unless you pass `--alert-existing`.

### Layout

- `src/core/` is runtime agnostic: no `fs`, `path`, `process` or other Node APIs, only web standard globals like `fetch`. `tsconfig.core.json` typechecks it with no Node types, and `test/coreBoundary.test.ts` checks the imports too.
- `src/local/` has the Node adapters and placeholders, plus the CLI.
- `scripts/` has capture, title collection, label sync and eval.
- `migrations/` has SQL that works in both SQLite and D1.

### Ports and what stands in for them right now

| Port (`src/core/ports`) | Phase 1 placeholder (`src/local`) | Later |
| --- | --- | --- |
| `Database` | `sqliteDatabase.ts` (better-sqlite3, runs `migrations/` on start, file at `data/deal-scout.db`) | Cloudflare D1 (`env.DB`, same shape) |
| `FeedSource` | `liveFeedSource.ts` (real feed via core `fetchFeed`), `fileFeedSource.ts` (saved captures, offline) | same core `fetchFeed` inside the Worker |
| `Embedder` | `fakeEmbedder.ts`: hashed bag of words, 256 dims, L2 normalized. **Only captures word overlap, not meaning.** | Workers AI embedding model |
| `WatchPlanner` | `stubWatchPlanner.ts`: rules that pull out `$` max price and "no/not/without" excludes | LLM with tool calling (`create_watch` etc. in `watchTools.ts`) |
| `BorderlineJudge` | `stubBorderlineJudge.ts`: always says no, logs each call so you can see how often the real model would run | small LLM yes/no call |
| `Notifier` | `consoleNotifier.ts`: prints title, store, price, score, tags, link and the feedback command | Telegram bot |
| `Clock` | `systemClock` | same |

Every spot where a real integration goes is marked `TODO(integration)`. Run `grep -rn "TODO(integration)" src` to list them.

## Setup

Needs Node 20 or newer (tested on Node 24).

```bash
npm install
```

npm 11 blocks install scripts by default. `package.json` already allows the two that are needed (`better-sqlite3`
for its native binary and `esbuild` for `tsx`/`vitest`). If `better-sqlite3` fails to load, run `npm rebuild better-sqlite3`.

Set a real contact for the User-Agent so RFD can reach you if something goes wrong:

```bash
export DEAL_SCOUT_CONTACT="you@example.com"   # UA becomes: DealScout/0.1 (personal use, contact you@example.com)
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm run watch:add -- "<request>"` | Create a watch for the default local user, e.g. `npm run watch:add -- "portable charger under $40, no cables"` |
| `npm run watch:list` | List watches with their parsed price, excludes, stores and thresholds |
| `npm run watch:remove -- <watchId>` | Deactivate a watch |
| `npm run check` | One check against the live feed (obeys the 2 minute guard) |
| `npm run check -- --file <path>` | One check against a saved capture, fully offline |
| `npm run check -- --force` | Skip the 2 minute guard once (does not override a 429 back off) |
| `npm run check -- --alert-existing` | On a first run, alert on posts already in the feed |
| `npm run check -- --verbose` | Also print every match decision (score, reason) |
| `npm run check -- --save-captures` | Also save each fresh live feed to `data/captures/` |
| `npm run check:loop` | Repeat the live check every 10 minutes. `-- --interval-minutes <n>` changes it, under 2 is refused. Stops if RFD blocks us |
| `npm run feed:capture` | Fetch the live feed once (guarded) and save it to `data/captures/feed-<timestamp>.xml`. The first capture is also copied to `test/fixtures/hot-deals-feed.xml` |
| `npm run titles:collect` | Merge all captures into `data/collected-titles.json`, deduped by post id |
| `npm run labels:sync` | Add newly collected titles to `data/labeled-posts.json` as unreviewed |
| `npm run feedback -- <alertId> up\|down` | Record feedback for an alert and maybe raise that watch's high threshold |
| `npm run eval` | Precision, recall, false positives and false negatives per eval watch |
| `npm test` | Run the tests (never touches the network) |
| `npm run typecheck` | Typecheck everything, plus `src/core` on its own without Node types |

## Being a good citizen with the feed

- Only the Atom feed URL is ever requested, with an honest User-Agent.
- **2 minute guard**: `fetchFeed` refuses a live request if the last one (saved in `feed_state.last_checked_at`) was under 2 minutes ago, unless `--force`. The time is recorded for every live request, whatever the outcome.
- **Conditional requests**: `Last-Modified` and `ETag` from each good response are sent back as `If-Modified-Since` / `If-None-Match`. RFD currently sends `Last-Modified` but no ETag. Captures keep their own validators (`<feed url>#capture` row), so a capture never takes a 304 that the checker needed.
- **429**: `Retry-After` (seconds or a date) is stored as `retry_after_until` and respected, even with `--force`. No header means a 15 minute back off.
- **Blocked**: any 401/403/451, a redirect to a host other than `forums.redflagdeals.com` (e.g. a tollbit subdomain), or a 200 that isn't an Atom feed counts as blocked. Redirects are followed by hand, so the other host is never contacted. It logs the status and final URL and stops. Later live fetches refuse to run until you pass `--force`. Nothing tries to get around a block.
- **Errors**: network errors and 5xx retry at most twice with exponential backoff. The backoff starts at 2 minutes (2, then 4) so even retries follow the 2 minute rule.

## Feedback and thresholds

Each watch has its own `highThreshold` and `lowThreshold` (defaults in `src/core/config.ts`).
`npm run feedback -- <alertId> down` records the rating and runs `suggestThreshold`. If at least 3 thumbs down
alerts scored below `highThreshold + 0.02`, the threshold is raised to just above the highest of those scores,
capped at 0.95. It never goes below 0.3 and is never lowered. The command prints what changed and why.

## Eval

1. Capture the feed now and then (`npm run feed:capture`, or run `check:loop -- --save-captures`) for a few days.
2. `npm run titles:collect` then `npm run labels:sync`.
3. Review `data/labeled-posts.json`. Each post has `shouldMatch` (watch labels it should match) and `reviewed`. Fix the labels and set `"reviewed": true`.
4. `npm run eval`. Only reviewed posts count, and it tells you how many are still unreviewed. `npm run eval -- --include-unreviewed` previews against the draft labels.

The four eval watches are listed at the top of `data/labeled-posts.json`. If the real titles don't have at least 3
positives for a watch, the eval says so instead of inventing posts. Expect weak numbers with the fake embedder.
The point is to have the harness ready to measure real embeddings.

## Data files

- `data/deal-scout.db` is the local SQLite database (gitignored).
- `data/captures/*.xml` holds raw feed captures.
- `data/collected-titles.json` holds every post title seen across captures.
- `data/labeled-posts.json` holds the eval labels.
- `test/fixtures/hot-deals-feed.xml` is a real capture used by the tests. The other fixtures are hand edited copies (single entry, malformed entries).

## Later phases checklist

- [ ] **D1 adapter**: create the database, apply `migrations/` with `wrangler d1 migrations apply`, pass `env.DB` as the `Database` (same `prepare/bind/first/all/run` shape).
- [ ] **Workers AI embedder**: implement `Embedder` with `env.AI` (batch call). Re-embed existing watches, since vectors from different embedders can't be compared. Re-tune thresholds with `npm run eval`.
- [ ] **Real LLM planner** with tool calling: hand `watchTools` to the model, validate tool input with `parseCreateWatchInput`, and have it write a rich `intentDescription` with synonyms and related products.
- [ ] **LLM borderline judge**: a small yes/no prompt with the post title, body start and the watch intent.
- [ ] **Telegram notifier** (`sendMessage`) and a **Telegram webhook** in `worker.fetch`. Check the secret token header and map Telegram chats to users.
- [ ] **Deploy with Wrangler**: copy `wrangler.toml.example` to `wrangler.toml`, fill in the D1 id, set secrets with `wrangler secret put`, then `wrangler deploy`. Keep the cron at 10 minutes.

## Known limitations

- The fake embedder only sees shared words. "portable charger" won't match "power bank" until real embeddings land, and "[Flo] Flo EV Charger Program" shares the word "charger".
- Posts are marked seen before matching, as the spec orders it. If the embedder fails during a run, those posts won't be retried.
- The eval matches on titles only, because collected titles don't keep post bodies.
