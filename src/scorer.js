import { clamp, mean, std, quantile, round4 } from './util.js';

/**
 * Cross-sectional scoring: winsorize each factor at the 2nd/98th percentile
 * of today's candidate pool, z-score it, then combine with the current
 * weight vector. Mutates each pool item with { z, score } and returns the
 * pool sorted by score descending.
 *
 * The z-vector is persisted with each pick so the learner can later
 * correlate "what the model saw on pick day" with realized returns.
 */
export function scorePool(pool, weights) {
  const keys = Object.keys(weights);
  const stats = {};

  for (const k of keys) {
    const vals = pool
      .map((p) => p.factors[k])
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    if (vals.length < 3) {
      stats[k] = null;
      continue;
    }
    const lo = quantile(vals, 0.02);
    const hi = quantile(vals, 0.98);
    const wins = vals.map((v) => clamp(v, lo, hi));
    const sd = std(wins);
    stats[k] = { lo, hi, mean: mean(wins), std: sd > 1e-9 ? sd : 1e-9 };
  }

  for (const p of pool) {
    let score = 0;
    const z = {};
    for (const k of keys) {
      const st = stats[k];
      const v = p.factors[k];
      let zi = 0;
      if (st && Number.isFinite(v)) {
        zi = clamp((clamp(v, st.lo, st.hi) - st.mean) / st.std, -4, 4);
      }
      z[k] = round4(zi);
      score += weights[k] * zi;
    }
    p.z = z;
    p.score = round4(score);
  }

  pool.sort((a, b) => b.score - a.score);
  return pool;
}
