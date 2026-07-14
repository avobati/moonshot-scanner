# Moonshot Scanner

A daily, self-improving scanner that hunts for stocks and crypto with the
statistical profile of past explosive movers (the kind that occasionally go
10–100x within months), tracks every pick it makes, and retunes its own
scoring model from realized performance.

> ⚠️ **Research tool — not financial advice.** Nothing can reliably predict
> 10–100x moves. Assets with that upside carry a commensurate chance of losing
> most of their value, and most picks in this category historically do lose
> money. The honest goal of this app is different: make falsifiable daily
> picks, measure them ruthlessly, and let the measurement improve the model.

## What it does every day

1. **TRACK** — every open pick is marked to market on a decaying schedule
   (day 1, 2, 3, 5, 7, 14, 21, 30 … 180). Each pick records its latest and
   peak return. Picks close automatically at the 180-day horizon.
2. **LEARN** — once ≥15 picks per asset class are ≥30 days old, the learner
   computes the Spearman correlation between each factor's pick-day z-score
   and the pick's realized peak return, then nudges every weight toward its
   correlation (learning rate 0.15, clamped, L1-normalized). Each retune is
   saved as a new immutable weights version — the model's evolution is fully
   auditable in the dashboard. Retunes happen at most weekly.
3. **SCAN** — rebuild the full universe and pick:
   - **Stocks**: all ~7,000 US-listed names (NASDAQ screener, one request),
     hard-filtered to tradable micro/small caps ($5M–$750M cap), pre-scored,
     top ~220 + 40 random names get 6 months of Yahoo daily bars and full
     factor scoring.
   - **Crypto**: top 2,000 coins by cap (CoinGecko), filtered to $3M–$500M
     caps with real volume; stables and wrapped/staked derivatives excluded.
   - 7 **top** picks + 3 **explore** picks per class are saved with entry
     price, factor snapshot, and the weights version that produced them.
     Explore picks are deliberate off-model samples — they give the learner
     data outside the model's comfort zone so it can discover factors it
     currently underrates.

## Factors

| Stocks | Crypto | Idea |
|---|---|---|
| `volSurge` | `turnover` | unusual volume precedes big moves |
| `mom30`, `mom7`, `accel` | `mom30`, `mom7`, `mom24`, `accel` | momentum + acceleration |
| `breakout` | `athDist` | strength near highs beats knife-catching |
| `volatility` | — | explosive movers are volatile before they explode |
| `microCap` | `microCap` | 10x math requires a small starting cap |
| `dollarVol` | — | liquidity floor so picks are actually tradable |

Factors are winsorized and z-scored **cross-sectionally against the same
day's candidate pool**, so the score is always "how unusual is this name
today", and the learner compares like with like.

## Architecture

- **Storage**: Neon Postgres (`runs`, `picks`, `marks`, `weights` tables).
  Schema is created automatically on first use.
- **Hosting**: Vercel — static dashboard (`index.html`) + serverless
  functions in `api/` (`summary`, `picks/latest`, `picks/history`,
  `weights`, `scan`, `cron/daily`).
- **Daily update**: Vercel Cron (`vercel.json`) hits `/api/cron/daily` at
  07:30 UTC, protected by the `CRON_SECRET` env var. The dashboard's
  **Run scan now** button triggers the same cycle manually;
  `POST /api/scan?dry=1` previews picks without writing anything.
- **Sources** (all free, no API keys): NASDAQ screener (universe),
  Yahoo Finance chart API (stock history/marks), CoinGecko (crypto).

## Local development

Requires Node.js ≥ 22.12. Create `.env` in this folder:

```
DATABASE_URL=postgres://...   # Neon connection string
CRON_SECRET=anything-random
```

```powershell
npm install
npm run daily   # run one full cycle now (~2-3 min: rate-limited API pacing)
npm start       # dashboard at http://localhost:5177
```

The local server also auto-starts a scan on startup whenever the last
completed run is older than 20 hours.

## Deploying your own

1. Create a Neon project, copy the pooled connection string.
2. `vercel link`, then set env vars: `DATABASE_URL` and `CRON_SECRET`
   (any random string — Vercel passes it to the cron as a bearer token).
3. `vercel --prod`. The cron schedule ships in `vercel.json`.

## How "continuously improves itself" actually works

Every pick permanently stores the factor z-scores the model saw on pick day.
Realized peak returns are the training signal; Spearman rank correlation is
the gradient (robust to the fat right tail this strategy hunts — a single
20x would wreck least squares). Weight updates are small, clamped, and
versioned, so the model can only drift as fast as evidence accumulates, and
you can always inspect *why* it changed (each version stores its sample size
and the per-factor correlations). Explore picks keep the training data from
collapsing into whatever the current model already likes.

Honest limitations, so future-you doesn't get surprised:

- ~30–180 days must pass before the first retune; until then it runs on
  sensible priors.
- The learner optimizes *ranking within its candidate pool*, not absolute
  returns — it cannot make a bear market go up.
- Survivorship: delisted stocks stop producing marks; their last known
  return stays in the sample (usually deeply negative, which is the point).
- One pick cohort per day means samples accumulate slowly. Patience.
