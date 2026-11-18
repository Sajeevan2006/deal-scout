# Setup

About 15 minutes. You need Node 20 or newer and a free [Cloudflare account](https://dash.cloudflare.com/sign-up).
Telegram can wait: until it's set up, alerts go to the Worker logs.

## 1. Install

```bash
git clone https://github.com/<you>/deal-scout.git
cd deal-scout
npm install
npx wrangler login
```

## 2. Create the database and your config

```bash
cp wrangler.toml.example wrangler.toml
npx wrangler d1 create deal-scout
```

Paste the `database_id` printed by the second command into `wrangler.toml`. That file is gitignored, so your id stays
local.

## 3. Create the tables

```bash
npm run db:migrate:remote
```

It asks for confirmation. In a non-interactive shell (CI, some IDE terminals), run
`CI=true npx wrangler d1 migrations apply deal-scout --remote` instead.

## 4. Set the secrets

```bash
npx wrangler secret put ADMIN_TOKEN    # protects the /api admin endpoints
npx wrangler secret put PAIRING_CODE   # you send /start <PAIRING_CODE> to your bot once to claim it
```

Use long random values, for example from `node -e "console.log(crypto.randomUUID())"`.

## 5. Deploy

```bash
npm run deploy
```

Note the URL it prints, like `https://deal-scout.<your-subdomain>.workers.dev`. The cron starts right away.

On a brand new account, the first deploy asks you to pick a `workers.dev` subdomain, and the URL can take a few minutes
to answer over HTTPS (TLS errors until the certificate is issued). The cron runs in the meantime.

## 6. Talk to it from your machine

```bash
cp .env.example .env
```

Set `WORKER_URL` and `ADMIN_TOKEN` in `.env`, then:

```bash
npm run status                                         # feed state, watches, AI settings, Telegram pairing
npm run remote -- watch "portable charger under \$40, no cables"
npm run remote -- watches
npm run logs                                           # live Worker logs, alerts show here until Telegram is set up
```

That's a working deployment. Next: [Telegram](telegram.md).

## Settings

Everything is optional and lives under `[vars]` in `wrangler.toml`. Defaults:

| Var | Default | What it does |
| --- | --- | --- |
| `CONTACT_EMAIL` | unset | Adds `contact <email>` to the User-Agent sent to RFD |
| `EMBEDDING_MODEL` | `@cf/baai/bge-base-en-v1.5` | Changing it re-embeds every watch on the next check |
| `LLM_PROVIDER` | `workers-ai` | Or `anthropic`, see below |
| `PLANNER_MODEL` / `JUDGE_MODEL` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | `claude-haiku-5-5` with `anthropic` |
| `HIGH_THRESHOLD` / `LOW_THRESHOLD` | `0.8` / `0.6` | Thresholds for new watches, and for watches re-embedded after a model change. See [Tuning](tuning.md) |
| `MAX_JUDGE_CALLS_PER_RUN` / `_PER_DAY` | `8` / `300` | Keeps the judge inside the free AI allowance |

Redeploy with `npm run deploy` after changing them.

## Using Claude instead of Workers AI

Workers AI handles the planner and judge for free. To use Claude Haiku instead:

```toml
# wrangler.toml [vars]
LLM_PROVIDER = "anthropic"
```

```bash
npx wrangler secret put ANTHROPIC_API_KEY
npm run deploy
```

At Deal Scout's volume that's fractions of a cent a day. Embeddings stay on Workers AI either way.

## Troubleshooting

- **Alerts only show in the logs**: Telegram isn't configured or not paired. `npm run remote -- telegram:status`.
- **The bot doesn't answer**: check `npm run remote -- telegram:status` (webhook URL, last error), and that you
  paired with `/start <PAIRING_CODE>` exactly.
- **`status` shows `lastStatus: "blocked"`**: RFD refused a request. Look at `npm run logs` for the status and URL,
  wait, then `npm run remote -- unblock`.
- **Changed `EMBEDDING_MODEL`**: watches are re-embedded on the next check and their thresholds reset to the new
  model's defaults.
- **`check` says "too soon"**: the 2 minute gap between feed requests always applies. The cron may have just run.
- **"Judge budget ran out"**: raise `MAX_JUDGE_CALLS_PER_DAY` (mind the free AI allowance) or raise thresholds.
- **`Configuration problem: ...` from the API**: a binding is missing in `wrangler.toml`. The message says which.
