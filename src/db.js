import { neon } from '@neondatabase/serverless';
import { CONFIG } from './config.js';
import { round4 } from './util.js';

let client = null;
let readyPromise = null;

export function sql() {
  if (!client) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is not set — create moonshot-scanner/.env locally or set the Vercel env var');
    }
    client = neon(process.env.DATABASE_URL);
  }
  return client;
}

/** JSONB columns come back as objects from Neon but as strings from some paths. */
export function asObj(v) {
  return typeof v === 'string' ? JSON.parse(v) : v;
}

/**
 * Create schema + seed weights once per process. Fast path is a single
 * existence check so warm serverless invocations pay ~1 round trip.
 */
export async function ensureReady() {
  if (!readyPromise) readyPromise = init();
  return readyPromise;
}

async function init() {
  const s = sql();
  const [{ ok }] = await s`SELECT to_regclass('public.picks') IS NOT NULL AS ok`;
  if (!ok) {
    await s`CREATE TABLE IF NOT EXISTS runs (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL DEFAULT now(),
      status TEXT NOT NULL DEFAULT 'running',
      stocks_universe INT DEFAULT 0,
      crypto_universe INT DEFAULT 0,
      stocks_candidates INT DEFAULT 0,
      crypto_candidates INT DEFAULT 0,
      picks_added INT DEFAULT 0,
      marks_added INT DEFAULT 0,
      picks_closed INT DEFAULT 0,
      notes JSONB
    )`;
    await s`CREATE TABLE IF NOT EXISTS weights (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL DEFAULT now(),
      asset_class TEXT NOT NULL,
      weights JSONB NOT NULL,
      meta JSONB
    )`;
    await s`CREATE TABLE IF NOT EXISTS picks (
      id SERIAL PRIMARY KEY,
      run_id INT NOT NULL,
      ts TIMESTAMPTZ NOT NULL DEFAULT now(),
      asset_class TEXT NOT NULL,
      symbol TEXT NOT NULL,
      name TEXT,
      source_id TEXT,
      mode TEXT NOT NULL DEFAULT 'top',
      rank INT,
      score DOUBLE PRECISION,
      entry_price DOUBLE PRECISION NOT NULL,
      market_cap DOUBLE PRECISION,
      factors JSONB,
      weights_id INT,
      status TEXT NOT NULL DEFAULT 'open',
      horizon_days INT NOT NULL,
      best_ret DOUBLE PRECISION DEFAULT 0,
      last_ret DOUBLE PRECISION DEFAULT 0,
      last_price DOUBLE PRECISION,
      last_mark_ts TIMESTAMPTZ,
      closed_ts TIMESTAMPTZ
    )`;
    await s`CREATE TABLE IF NOT EXISTS marks (
      id SERIAL PRIMARY KEY,
      pick_id INT NOT NULL,
      ts TIMESTAMPTZ NOT NULL DEFAULT now(),
      age_days INT NOT NULL,
      price DOUBLE PRECISION NOT NULL,
      ret DOUBLE PRECISION NOT NULL
    )`;
    await s`CREATE INDEX IF NOT EXISTS idx_picks_status ON picks(status)`;
    await s`CREATE INDEX IF NOT EXISTS idx_picks_class_ts ON picks(asset_class, ts)`;
    await s`CREATE INDEX IF NOT EXISTS idx_marks_pick ON marks(pick_id)`;
    await s`CREATE INDEX IF NOT EXISTS idx_weights_class ON weights(asset_class, id)`;
  }
  for (const assetClass of Object.keys(CONFIG.initialWeights)) {
    const rows = await s`SELECT id FROM weights WHERE asset_class = ${assetClass} LIMIT 1`;
    if (!rows.length) {
      await s`INSERT INTO weights (asset_class, weights, meta)
        VALUES (${assetClass}, ${JSON.stringify(CONFIG.initialWeights[assetClass])}::jsonb,
                ${JSON.stringify({ reason: 'seed' })}::jsonb)`;
    }
  }
}

/** Latest weight version for an asset class: { id, ts, weights, meta }. */
export async function currentWeights(assetClass) {
  const rows = await sql()`
    SELECT * FROM weights WHERE asset_class = ${assetClass} ORDER BY id DESC LIMIT 1`;
  const r = rows[0];
  return { ...r, weights: asObj(r.weights), meta: r.meta ? asObj(r.meta) : null };
}

export async function insertWeights(assetClass, weights, meta) {
  const rows = await sql()`
    INSERT INTO weights (asset_class, weights, meta)
    VALUES (${assetClass}, ${JSON.stringify(weights)}::jsonb, ${JSON.stringify(meta)}::jsonb)
    RETURNING id`;
  return rows[0].id;
}

export async function insertRun() {
  const rows = await sql()`INSERT INTO runs (status) VALUES ('running') RETURNING id`;
  return rows[0].id;
}

export async function finishRun(id, f) {
  await sql()`UPDATE runs SET
    status = ${f.status},
    stocks_universe = ${f.stocksUniverse ?? 0},
    crypto_universe = ${f.cryptoUniverse ?? 0},
    stocks_candidates = ${f.stocksCandidates ?? 0},
    crypto_candidates = ${f.cryptoCandidates ?? 0},
    picks_added = ${f.picksAdded ?? 0},
    marks_added = ${f.marksAdded ?? 0},
    picks_closed = ${f.picksClosed ?? 0},
    notes = ${JSON.stringify(f.notes ?? null)}::jsonb
    WHERE id = ${id}`;
}

export async function insertPick(p) {
  const rows = await sql()`
    INSERT INTO picks (run_id, asset_class, symbol, name, source_id, mode, rank, score,
                       entry_price, market_cap, factors, weights_id, horizon_days)
    VALUES (${p.runId}, ${p.assetClass}, ${p.symbol}, ${p.name ?? null},
            ${p.sourceId ?? p.symbol}, ${p.mode}, ${p.rank ?? null}, ${p.score ?? null},
            ${p.entryPrice}, ${p.marketCap ?? null}, ${JSON.stringify(p.factors ?? null)}::jsonb,
            ${p.weightsId ?? null}, ${CONFIG.horizonDays})
    RETURNING id`;
  return rows[0].id;
}

export async function openPicks(assetClass = null) {
  return assetClass
    ? await sql()`SELECT * FROM picks WHERE status = 'open' AND asset_class = ${assetClass}`
    : await sql()`SELECT * FROM picks WHERE status = 'open'`;
}

export function ageDays(pick, nowMs = Date.now()) {
  return (nowMs - new Date(pick.ts).getTime()) / 86400000;
}

/**
 * Record a fresh price observation for a pick. Always refreshes last_price,
 * last_ret and best_ret; inserts an immutable mark row only when
 * `markAgeDays` is provided.
 */
export async function recordProgress(pick, price, markAgeDays = null) {
  const ret = round4(price / pick.entry_price - 1);
  const best = Math.max(pick.best_ret ?? 0, ret);
  await sql()`UPDATE picks SET last_price = ${price}, last_ret = ${ret},
    best_ret = ${best}, last_mark_ts = now() WHERE id = ${pick.id}`;
  if (markAgeDays != null) {
    await sql()`INSERT INTO marks (pick_id, age_days, price, ret)
      VALUES (${pick.id}, ${markAgeDays}, ${price}, ${ret})`;
    return true;
  }
  return false;
}

export async function closePick(pick) {
  await sql()`UPDATE picks SET status = 'closed', closed_ts = now() WHERE id = ${pick.id}`;
}

export async function latestCompletedRun() {
  const rows = await sql()`SELECT * FROM runs WHERE status = 'ok' ORDER BY id DESC LIMIT 1`;
  return rows[0] ?? null;
}
