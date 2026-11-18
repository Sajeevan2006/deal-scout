# Deal Scout

> **Personal project, for learning only.** It reads only the public RedFlagDeals Hot Deals Atom feed
> (`https://forums.redflagdeals.com/feed/forum/9`), at most once every 2 minutes and every 10 minutes by default.
> It never scrapes forum pages. Not for commercial use.

Deal Scout watches the RFD Hot Deals forum and sends you a Telegram message when a new post matches something you
asked for. Matching is by meaning, not keywords: "portable charger" matches "[Amazon] Anker 20000mAh Power Bank $29".

- You send the bot what you want, in plain words: *portable charger under $40, no cables*
- An LLM turns that into a watch (description, synonyms, brands, price limit, excluded words)
- Every 10 minutes a Cloudflare cron checks the feed, embeds new posts, scores them against your watches, and asks an
  LLM to double check the borderline ones
- Matches arrive in Telegram with 👍 / 👎 buttons. Enough 👎 makes a watch stricter.

Everything runs on the **Cloudflare free plan** (Workers, D1, Workers AI). Each deployment belongs to one person: clone
it, deploy it to your own Cloudflare account, pair your own Telegram bot.

> **Status: match thresholds are still being tuned.** The defaults work but aren't calibrated yet, so expect some
> borderline posts to need the LLM judge and the occasional miss or false alert. See
> [Tuning thresholds with the eval](#tuning-thresholds-with-the-eval).

## Contents

- [How it works](#how-it-works)
- [Setup](#setup) (about 15 minutes)
- [Telegram](#telegram)
- [Using Claude instead of Workers AI](#using-claude-instead-of-workers-ai-optional)
- [Admin API and the remote CLI](#admin-api-and-the-remote-cli)
- [Tuning thresholds with the eval](#tuning-thresholds-with-the-eval)
- [Staying inside the free plan](#staying-inside-the-free-plan)
- [Being a good citizen with the feed](#being-a-good-citizen-with-the-feed)
- [Local development](#local-development)
- [Troubleshooting](#troubleshooting)
- [Project layout](#project-layout)

## How it works

```
Cron every 10 min ─► fetch feed ─► parse ─► new posts only ─► embed (1 batch) ─► score vs watches ─► alerts ─► Telegram
                     304 aware      Atom     seen_posts          Workers AI        hard filters        dedupe
                     2 min guard                                 bge-base          judge (LLM) for     👍/👎 buttons
                                                                                   borderline scores

Telegram message ─► webhook (secret checked) ─► LLM planner ─► embed intent once ─► watches table
```

How a check works:

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

## Setup

You need Node 20 or newer, and a free [Cloudflare account](https://dash.cloudflare.com/sign-up). Telegram can wait until
later: without it, alerts go to the Worker logs.

**1. Install**

```bash
git clone https://github.com/<you>/deal-scout.git
cd deal-scout
npm install
npx wrangler login
```

**2. Create the database and your config**

```bash
npx wrangler d1 create deal-scout
cp wrangler.toml.example wrangler.toml
```

In `wrangler.toml`, paste the `database_id` printed by the first command. `wrangler.toml` is gitignored.

**3. Create the tables**

```bash
npm run db:migrate:remote
```

**4. Set the secrets**

```bash
npx wrangler secret put ADMIN_TOKEN    # protects the /api admin endpoints
npx wrangler secret put PAIRING_CODE   # you send /start <PAIRING_CODE> to your bot once to claim it
```

Use long random values, for example from `node -e "console.log(crypto.randomUUID())"`.

**5. Deploy**

```bash
npm run deploy
```

Note the URL it prints, like `https://deal-scout.<your-subdomain>.workers.dev`. The cron starts right away. On a
brand new account, the first deploy asks you to pick a `workers.dev` subdomain, and the URL can take several minutes
to start answering over HTTPS (TLS errors until the certificate is issued). The cron runs in the meantime.

**6. Talk to it from your machine**

```bash
cp .env.example .env
```

Set `WORKER_URL` and `ADMIN_TOKEN` in `.env`, then:

```bash
npm run status                                         # feed state, watches, AI settings, Telegram pairing
npm run remote -- watch "portable charger under \$40, no cables"
npm run remote -- watches
npm run logs                                           # live Worker logs, alerts show up here until Telegram is set up
```

That's a working deployment. Next, set up Telegram so alerts reach your phone.

## Telegram

1. In Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot` and follow the prompts. It gives you a
   bot token like `123456789:AA...`.
2. Store the token, plus a webhook secret of your choice (letters, digits, `_` and `-` only):

   ```bash
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
   ```

3. Register the webhook and the bot's command menu. The Worker makes these calls itself, so the token never leaves
   Cloudflare:

   ```bash
   npm run telegram:setup
   ```

4. Open your bot in Telegram and send `/start <your PAIRING_CODE>`. That chat becomes the owner. Every other chat is
   turned away.
5. Send what you're looking for, like `air fryer under $100`.

Bot commands:

| Message | What it does |
| --- | --- |
| any text, or `/watch <text>` | Create a watch |
| `/list` | Your watches, with remove buttons |
| `/remove <id>` | Stop a watch |
| `/help` | How it works |
| 👍 / 👎 on an alert | Rate it. 3 or more 👎 just above a watch's threshold raises that threshold |

To move the bot to another chat: `npm run remote -- telegram:unpair`, then `/start <PAIRING_CODE>` from the new chat.

## Using Claude instead of Workers AI (optional)

Workers AI handles the planner and judge for free. To use Claude Haiku instead:

```toml
# wrangler.toml [vars]
LLM_PROVIDER = "anthropic"
```

```bash
npx wrangler secret put ANTHROPIC_API_KEY
npm run deploy
```

It defaults to `claude-haiku-5-5` (override with `PLANNER_MODEL` / `JUDGE_MODEL`). At Deal Scout's volume that's
fractions of a cent a day. Embeddings stay on Workers AI either way.

## Admin API and the remote CLI

All `/api` routes need `Authorization: Bearer <ADMIN_TOKEN>`. `npm run remote -- <command>` wraps them using
`WORKER_URL` and `ADMIN_TOKEN` from `.env`.

| `npm run remote --` | Route | What it does |
| --- | --- | --- |
| `status` | `GET /api/status` | Feed state, watch count, judge calls today, AI settings, Telegram state |
| `watches` | `GET /api/watches` | List watches |
| `watch "<request>"` | `POST /api/watches` | Create a watch, body `{"text": "..."}` |
| `remove <id>` | `DELETE /api/watches/<id>` | Stop a watch |
| `thresholds <id> <high> <low>` | `POST /api/watches/<id>/thresholds` | Set a watch's thresholds |
| `check [--force] [--alert-existing]` | `POST /api/check` | Run a check now (obeys the 2 minute guard unless `--force`, never overrides a 429) |
| `feedback <alertId> up\|down` | `POST /api/feedback` | Rate an alert |
| `unblock` | `POST /api/unblock` | Allow live fetches again after RFD blocked one. Find out why first |
| `telegram:setup` | `POST /api/telegram/setup` | Register the webhook and commands |
| `telegram:status` | `GET /api/telegram/status` | Webhook info and pairing state |
| `telegram:unpair` | `POST /api/telegram/unpair` | Forget the owner chat |
| (labels:pull) | `GET /api/posts?days=30` | Posts the bot has seen, with the start of each body |

`npm run status` and `npm run telegram:setup` are shortcuts for the matching `remote` commands.

## Tuning thresholds with the eval

> **In progress.** The defaults below haven't been calibrated on labeled data yet. A first live check showed
> `bge-base-en-v1.5` scoring unrelated posts around 0.54–0.67, so with `low` at 0.6 the judge sees more posts than it
> should (it rejected them correctly). The plan: collect a few days of real posts, label them, run the eval, and update
> the defaults here.

Each watch has a `high` and `low` threshold. The defaults for `bge-base-en-v1.5` (0.8 / 0.6) are deliberately
conservative starting guesses: the judge covers the band in between, and 👎 feedback can only raise thresholds. Measure
them on real posts once you have some:

1. Let the deployed bot run for a few days. It stores the title and the start of every post it sees.
2. `npm run labels:pull` copies those posts into `data/collected-titles.json`.
3. `npm run labels:sync` adds them to `data/labeled-posts.json` as unreviewed.
4. Review `data/labeled-posts.json`: put the matching watch labels in `shouldMatch` and set `"reviewed": true`. The
   eval watches are listed at the top of the file. Change them to things you actually want.
5. Add `CLOUDFLARE_ACCOUNT_ID` and `WORKERS_AI_API_TOKEN` to `.env` (see `.env.example`), then `npm run eval`.

The eval prints precision, recall, false positives and negatives per watch, the score spread of positives and
negatives, and a threshold sweep with suggested `high` / `low` values. Useful flags:

- `--judge`: also run the LLM judge on borderline scores
- `--planner rules|llm`: how watch descriptions are written (LLM plans are cached in `data/eval-plans.json`)
- `--query-prefix`: try bge's recommended search prefix on watch descriptions
- `--embedder fake`: run fully offline
- `--include-unreviewed`: preview with draft labels

Apply what you learn with `HIGH_THRESHOLD` / `LOW_THRESHOLD` in `wrangler.toml` (new watches) or
`npm run remote -- thresholds <id> <high> <low>` (existing ones). The eval matches on title + body snippet, like
the Worker.

## Staying inside the free plan

| Limit (free plan) | What Deal Scout does |
| --- | --- |
| **10 ms CPU per invocation** | Purpose built Atom reader instead of an XML library, embeddings stored as base64 float32 (cheap to decode), per post and per watch filter work cached. `npm run bench` measures it: about 6 ms worst case (15 new posts × 20 watches, cold), far less on a normal run with 0–3 new posts, and near zero on a 304. Real numbers: dashboard → Workers → deal-scout → Metrics → CPU time. |
| **50 D1 queries per invocation** | Bulk statements (`json_each`) for seen posts. A typical run uses about 12 queries plus one per alert. |
| **D1 rows read per day** | No `COUNT(*)` over growing tables. Seen posts are pruned after 30 days. |
| **10,000 Workers AI neurons per day** | Estimated about 2,000 a day for one person with ~10 watches: embedding ~150 posts costs ~100 neurons, a judge call ~10, a new watch ~110. Judge calls are capped at 8 per run and 300 per day (`MAX_JUDGE_CALLS_PER_RUN` / `_PER_DAY`). Over the cap, borderline posts are skipped and the run says so. |
| **5 cron triggers** | One, every 10 minutes. |

If you ever outgrow it, Workers Paid ($5/month) raises the cron CPU limit to 30 seconds. Nothing else changes.

## Being a good citizen with the feed

- Only the Atom feed URL is ever requested, with an honest User-Agent (`DealScout/0.2 (personal use)`). Setting the
  optional `CONTACT_EMAIL` var adds a contact to it.
- **2 minute guard**: a live request is refused if the last one (`feed_state.last_checked_at`) was under 2 minutes
  ago. The cron runs every 10.
- **Conditional requests**: `Last-Modified` / `ETag` are sent back, so an unchanged feed is a cheap 304.
- **429**: `Retry-After` (seconds or a date) is respected even with `--force`. No header means a 15 minute back off.
- **Blocked**: a 401/403/451, a redirect to another host, or a 200 that isn't an Atom feed counts as blocked.
  Redirects are followed by hand, so the other host is never contacted. Fetching stops until you run
  `npm run remote -- unblock`. Nothing tries to get around a block.
- **Errors**: network errors and 5xx are left for the next cron run. The local CLI retries at most twice, starting at
  2 minutes.

## Local development

```bash
npm test             # 200+ tests, never touch the network
npm run typecheck    # everything, plus Worker-side code without Node types
npm run bench        # CPU estimate for a feed check
npm run build        # bundle the Worker without deploying (needs wrangler.toml)
```

**Worker locally**: copy `.dev.vars.example` to `.dev.vars`, run `npm run db:migrate:local`, then `npm run dev`.
Workers AI always runs remotely, so local dev needs `wrangler login`. Trigger the cron with
`curl http://127.0.0.1:8787/cdn-cgi/local/scheduled`.

**Node CLI**: the same pipeline also runs locally against SQLite (`data/deal-scout.db`, gitignored), handy for trying
things out. With nothing in `.env` it uses an offline word overlap embedder and rule based planner. With Workers AI
or Anthropic credentials in `.env` it uses the real models over their REST APIs.

| Command | What it does |
| --- | --- |
| `npm run watch:add -- "<request>"` | Create a local watch |
| `npm run watch:list` / `watch:remove -- <id>` | List / remove local watches |
| `npm run check -- --file <path>` | Check a saved capture, fully offline (`--alert-existing`, `--verbose`) |
| `npm run check` / `check:loop` | Check the live feed once / every 10 minutes (obeys every rule above) |
| `npm run feedback -- <alertId> up\|down` | Rate a local alert |
| `npm run feed:capture` / `titles:collect` | Save the live feed / merge captures into `data/collected-titles.json` |

## Troubleshooting

- **Alerts only show in the logs**: Telegram isn't configured or not paired. `npm run remote -- telegram:status`.
- **The bot doesn't answer**: check `npm run remote -- telegram:status` (webhook URL, last error), and that you
  paired with `/start <PAIRING_CODE>` exactly.
- **`status` shows `lastStatus: "blocked"`**: RFD refused a request. Look at `npm run logs` for the status and URL,
  wait, then `npm run remote -- unblock`.
- **Changed `EMBEDDING_MODEL`**: watches are re-embedded on the next check and their thresholds reset to the new
  model's defaults.
- **"Judge budget ran out"**: raise `MAX_JUDGE_CALLS_PER_DAY` (mind the 10k neuron allowance) or raise thresholds.

## Project layout

- `src/core/` is the runtime agnostic pipeline: feed fetch and parse, matching, watches, feedback, D1 shaped queries.
- `src/adapters/` holds Workers AI, Claude, Telegram and notifier adapters (web standard APIs only).
- `src/worker/` is the Cloudflare Worker: cron, Telegram webhook, admin API.
- `src/local/` is the Node CLI with SQLite and offline stand ins.
- `scripts/` holds eval, labeling, capture, bench and the remote admin client.
- `migrations/` holds SQL that runs on both D1 and SQLite.

`tsconfig.core.json` typechecks `core`, `adapters` and `worker` without Node types, and `test/coreBoundary.test.ts`
checks their imports, so nothing Node-only sneaks into the Worker.

## Known limitations

- The judge and planner run on open models by default. They're good, not perfect. Use 👎 and the eval.
- The judge only sees the title and the first 300 characters of the post.
- One owner per deployment by design. Someone else who wants alerts deploys their own copy.
