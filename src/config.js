import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const CONFIG = {
  root: ROOT,
  dataDir: path.join(ROOT, 'data'),
  logPath: path.join(ROOT, 'data', 'scanner.log'),
  htmlPath: path.join(ROOT, 'index.html'),

  port: 5177,
  // Server auto-runs a scan on startup if the last run is older than this.
  staleHours: 20,

  // How long a pick is tracked before it is closed out.
  horizonDays: 180,
  // Days after entry on which a performance mark is recorded.
  markDays: [1, 2, 3, 4, 5, 7, 10, 14, 21, 30, 45, 60, 90, 120, 150, 180],

  stocks: {
    minPrice: 0.1,
    maxPrice: 100,
    minMarketCap: 5e6,      // $5M — below this, data quality and tradability collapse
    maxMarketCap: 750e6,    // 10x from >$750M is vanishingly rare in 6 months
    minDollarVolumeToday: 50_000, // coarse tradability floor from the screener snapshot
    candidates: 220,        // top pre-scored names that get full history + factor scoring
    exploreCandidates: 40,  // random sample from the rest of the filtered universe
    picksTop: 7,
    picksExplore: 3,
    // Names that are structurally incapable of a clean 10x (derivative listings, shells)
    junkName: /warrant|right(s)? |unit(s)? |preferred|acquisition corp/i,
  },

  crypto: {
    pages: 8,               // 8 x 250 = top 2000 coins by market cap
    minMarketCap: 3e6,
    maxMarketCap: 500e6,
    minVolume: 100_000,     // 24h USD volume floor
    picksTop: 7,
    picksExplore: 3,
  },

  // Initial factor weights. The learner replaces these with data-driven versions
  // once enough picks have matured. Weights are L1-normalized to 1.
  initialWeights: {
    stock: {
      volSurge: 0.18,   // recent volume vs its own baseline (log ratio)
      mom30: 0.14,      // ~30 calendar day return
      mom7: 0.10,       // ~7 calendar day return
      accel: 0.10,      // short momentum minus its pro-rata share of long momentum
      breakout: 0.16,   // close vs 6-month high (1.0 = at the high)
      volatility: 0.12, // stdev of daily log returns, last ~30 bars
      microCap: 0.15,   // -log10(market cap): smaller caps score higher
      dollarVol: 0.05,  // log10 avg daily dollar volume (liquidity)
    },
    crypto: {
      turnover: 0.18,   // 24h volume / market cap
      mom30: 0.15,
      mom7: 0.14,
      mom24: 0.08,
      accel: 0.10,
      microCap: 0.22,
      athDist: 0.13,    // closeness to all-time high (1.0 = at ATH)
    },
  },

  learner: {
    minSamples: 15,      // matured picks required per asset class before learning
    minAgeDays: 30,      // a pick must be at least this old to count as a sample
    minDaysBetween: 7,   // don't re-learn more often than weekly
    learningRate: 0.15,
    minWeight: 0.01,
    maxWeight: 0.35,
    minTotalDelta: 0.01, // skip saving a new version if weights barely moved
  },
};
