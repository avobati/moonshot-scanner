import { CONFIG } from './config.js';
import { sql, asObj, currentWeights, insertWeights } from './db.js';
import { clamp, log, round4, spearman } from './util.js';

/**
 * The self-improvement loop.
 *
 * Every pick stores the factor z-scores the model saw on pick day. Once
 * enough picks are >= minAgeDays old, we compute the Spearman rank
 * correlation between each factor's z-score and the best return the pick
 * has achieved so far, then nudge each weight in the direction of its
 * correlation. Weights are clamped and re-normalized (L1 = 1) and saved as
 * a new immutable version, so the model's entire evolution is auditable.
 *
 * Spearman + best-return targets keep the update robust to the extreme
 * right tail this strategy hunts for (one 20x would wreck a least-squares
 * fit).
 */
export async function maybeLearn(assetClass) {
  const cfg = CONFIG.learner;
  const cur = await currentWeights(assetClass);

  const daysSinceLast = (Date.now() - new Date(cur.ts).getTime()) / 86400000;
  if (daysSinceLast < cfg.minDaysBetween) {
    return { assetClass, learned: false, reason: 'too soon since last version' };
  }

  const rows = await sql()`
    SELECT ts, factors, best_ret FROM picks
    WHERE asset_class = ${assetClass} AND factors IS NOT NULL`;

  const samples = [];
  for (const r of rows) {
    const age = (Date.now() - new Date(r.ts).getTime()) / 86400000;
    if (age < cfg.minAgeDays) continue;
    const parsed = asObj(r.factors);
    if (!parsed?.z) continue;
    samples.push({ z: parsed.z, y: clamp(r.best_ret ?? 0, -0.95, 20) });
  }

  if (samples.length < cfg.minSamples) {
    return {
      assetClass,
      learned: false,
      reason: `need ${cfg.minSamples} matured picks, have ${samples.length}`,
    };
  }

  const keys = Object.keys(cur.weights);
  const ys = samples.map((s) => s.y);
  const correlations = {};
  for (const k of keys) {
    correlations[k] = round4(spearman(samples.map((s) => s.z?.[k] ?? 0), ys));
  }

  let next = {};
  for (const k of keys) {
    next[k] = clamp(cur.weights[k] + cfg.learningRate * correlations[k], cfg.minWeight, cfg.maxWeight);
  }
  const sum = Object.values(next).reduce((a, b) => a + b, 0);
  for (const k of keys) next[k] = round4(next[k] / sum);

  const totalDelta = keys.reduce((a, k) => a + Math.abs(next[k] - cur.weights[k]), 0);
  if (totalDelta < cfg.minTotalDelta) {
    return { assetClass, learned: false, reason: 'weights already converged for now' };
  }

  const id = await insertWeights(assetClass, next, {
    reason: 'learned',
    samples: samples.length,
    correlations,
    previousId: cur.id,
    totalDelta: round4(totalDelta),
  });
  log(`learner[${assetClass}]: new weights v${id} from ${samples.length} samples`, next);
  return { assetClass, learned: true, weightsId: id, samples: samples.length, correlations };
}
