import { CONFIG } from './config.js';
import { sql, ensureReady, asObj, latestCompletedRun } from './db.js';

/**
 * Read-model queries shared by the local dev server (src/server.js) and the
 * Vercel serverless functions (api/*).
 */

function normalizePick(p) {
  return { ...p, factors: p.factors ? asObj(p.factors) : null };
}

function perfStats(rows) {
  const matured = rows.filter(
    (p) => (Date.now() - new Date(p.ts).getTime()) / 86400000 >= CONFIG.learner.minAgeDays
  );
  const withData = matured.filter((p) => p.last_mark_ts != null);
  const avg = (arr, f) => (arr.length ? arr.reduce((a, b) => a + f(b), 0) / arr.length : null);
  const share = (arr, f) => (arr.length ? arr.filter(f).length / arr.length : null);
  let best = null;
  for (const p of rows) {
    if (p.last_mark_ts == null) continue; // best_ret is meaningless before the first mark
    if (p.best_ret != null && (best == null || p.best_ret > best.best_ret)) best = p;
  }
  return {
    totalPicks: rows.length,
    openPicks: rows.filter((p) => p.status === 'open').length,
    matured: withData.length,
    avgBestRet: avg(withData, (p) => p.best_ret ?? 0),
    avgLastRet: avg(withData, (p) => p.last_ret ?? 0),
    hit50: share(withData, (p) => (p.best_ret ?? 0) >= 0.5),
    hit100: share(withData, (p) => (p.best_ret ?? 0) >= 1.0),
    hit10x: share(withData, (p) => (p.best_ret ?? 0) >= 9.0),
    bestPick: best
      ? { symbol: best.symbol, assetClass: best.asset_class, bestRet: best.best_ret, ts: best.ts }
      : null,
  };
}

export async function getSummary() {
  await ensureReady();
  const run = await latestCompletedRun();
  const picks = await sql()`SELECT * FROM picks`;
  const weightRows = await sql()`SELECT * FROM weights ORDER BY id DESC`;
  const weights = {};
  for (const assetClass of ['stock', 'crypto']) {
    const rows = weightRows.filter((w) => w.asset_class === assetClass);
    weights[assetClass] = {
      current: rows[0]
        ? { id: rows[0].id, ts: rows[0].ts, weights: asObj(rows[0].weights), meta: rows[0].meta ? asObj(rows[0].meta) : null }
        : null,
      versions: rows.length,
    };
  }
  return {
    latestRun: run,
    stats: {
      overall: perfStats(picks),
      stock: perfStats(picks.filter((p) => p.asset_class === 'stock')),
      crypto: perfStats(picks.filter((p) => p.asset_class === 'crypto')),
    },
    weights,
  };
}

export async function getLatestPicks() {
  await ensureReady();
  const run = await latestCompletedRun();
  if (!run) return { run: null, stocks: [], crypto: [] };
  // The most recent cohort per asset class (a class may fail on a given day)
  const rows = await sql()`
    SELECT p.* FROM picks p
    WHERE p.run_id = (SELECT MAX(run_id) FROM picks p2 WHERE p2.asset_class = p.asset_class)
    ORDER BY p.rank ASC`;
  const picks = rows.map(normalizePick);
  return {
    run,
    stocks: picks.filter((p) => p.asset_class === 'stock'),
    crypto: picks.filter((p) => p.asset_class === 'crypto'),
  };
}

export async function getHistory(limit = 300) {
  await ensureReady();
  const capped = Math.min(1000, Math.max(1, Number(limit) || 300));
  const rows = await sql()`SELECT * FROM picks ORDER BY id DESC LIMIT ${capped}`;
  return rows.map(normalizePick);
}

export async function getWeights() {
  await ensureReady();
  const rows = await sql()`SELECT * FROM weights ORDER BY id DESC`;
  const shape = (r) => ({
    id: r.id, ts: r.ts, weights: asObj(r.weights), meta: r.meta ? asObj(r.meta) : null,
  });
  return {
    stock: rows.filter((r) => r.asset_class === 'stock').map(shape),
    crypto: rows.filter((r) => r.asset_class === 'crypto').map(shape),
  };
}
