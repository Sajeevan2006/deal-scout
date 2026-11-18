# Admin API and CLI

## Admin API

All `/api` routes need `Authorization: Bearer <ADMIN_TOKEN>`. `npm run remote -- <command>` wraps them using
`WORKER_URL` and `ADMIN_TOKEN` from `.env`.

| `npm run remote --` | Route | What it does |
| --- | --- | --- |
| `status` | `GET /api/status` | Feed state, watch count, judge calls today, AI settings, Telegram state |
| `watches` | `GET /api/watches` | List watches |
| `watch "<request>"` | `POST /api/watches` | Create a watch, body `{"text": "..."}` |
| `remove <id>` | `DELETE /api/watches/<id>` | Stop a watch |
| `thresholds <id> <high> <low>` | `POST /api/watches/<id>/thresholds` | Set a watch's thresholds |
| `check [--alert-existing] [--force]` | `POST /api/check` | Run a check now. Always obeys the 2 minute gap and any 429 back off. `--alert-existing` scores every post in the feed, not just new ones. `--force` retries once after a block |
| `feedback <alertId> up\|down` | `POST /api/feedback` | Rate an alert |
| `unblock` | `POST /api/unblock` | Allow live fetches again after RFD blocked one. Find out why first |
| `telegram:setup` | `POST /api/telegram/setup` | Register the webhook and commands |
| `telegram:status` | `GET /api/telegram/status` | Webhook info and pairing state |
| `telegram:unpair` | `POST /api/telegram/unpair` | Forget the owner chat |
| (`npm run labels:pull`) | `GET /api/posts?days=30` | Posts the bot has seen, with the start of each body |

`npm run status` and `npm run telegram:setup` are shortcuts for the matching `remote` commands. `npm run logs` streams
the Worker's logs (`wrangler tail`).

## Running the Worker locally

```bash
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
curl http://127.0.0.1:8787/cdn-cgi/local/scheduled   # trigger the cron
```

Workers AI always runs remotely, so local dev needs `wrangler login`. `npm run build` bundles the Worker without
deploying.

## Local CLI

The same pipeline also runs on your machine against SQLite (`data/deal-scout.db`, gitignored), handy for trying things
out. With nothing in `.env` it uses an offline word overlap embedder and a rule based planner. With Workers AI or
Anthropic credentials in `.env` (see `.env.example`) it uses the real models over their REST APIs.

| Command | What it does |
| --- | --- |
| `npm run watch:add -- "<request>"` | Create a local watch |
| `npm run watch:list` / `watch:remove -- <id>` | List / remove local watches |
| `npm run check -- --file <path>` | Check a saved capture, fully offline (`--alert-existing`, `--verbose`) |
| `npm run check` / `check:loop` | Check the live feed once / every 10 minutes (same rules as the Worker) |
| `npm run feedback -- <alertId> up\|down` | Rate a local alert |
| `npm run feed:capture` / `titles:collect` | Save the live feed / merge captures into `data/collected-titles.json` |
