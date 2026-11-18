# Tuning thresholds

> **In progress.** The defaults haven't been calibrated on labeled data yet. A first live check showed
> `bge-base-en-v1.5` scoring unrelated posts around 0.54–0.67, so with `low` at 0.6 the judge sees more posts than it
> should (it rejected them correctly). The plan: collect a few days of real posts, label them, run the eval, and update
> the defaults.

Each watch has two thresholds:

- score ≥ `high`: alert
- score < `low`: skip
- in between: the LLM judge decides

The defaults for `bge-base-en-v1.5` (0.8 / 0.6) are deliberately conservative starting guesses. The judge covers the band
in between, and 👎 feedback can only raise thresholds.

## Measure them on real posts

1. Let the deployed bot run for a few days. It stores the title and the start of every post it sees.
2. `npm run labels:pull` copies those posts into `data/collected-titles.json`.
3. `npm run labels:sync` adds them to `data/labeled-posts.json` as unreviewed.
4. Review `data/labeled-posts.json`: put the matching watch labels in `shouldMatch` and set `"reviewed": true`. The
   eval watches are listed at the top of the file. Change them to things you actually want.
5. Add `CLOUDFLARE_ACCOUNT_ID` and `WORKERS_AI_API_TOKEN` to `.env` (see `.env.example`), then `npm run eval`.

The eval prints precision, recall, false positives and negatives per watch, the score spread of positives and
negatives, and a threshold sweep with suggested `high` / `low` values.

| Flag | What it does |
| --- | --- |
| `--judge` | Also run the LLM judge on borderline scores |
| `--planner rules\|llm` | How watch descriptions are written (LLM plans are cached in `data/eval-plans.json`) |
| `--query-prefix` | Try bge's recommended search prefix on watch descriptions |
| `--embedder fake` | Run fully offline |
| `--include-unreviewed` | Preview with draft labels |

## Apply what you learn

- New watches: `HIGH_THRESHOLD` / `LOW_THRESHOLD` under `[vars]` in `wrangler.toml`, then `npm run deploy`.
- Existing watches: `npm run remote -- thresholds <id> <high> <low>`.

The eval scores title + body snippet, the same text the Worker embeds.
