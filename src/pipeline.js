import { CONFIG } from './config.js';
import {
  sql, ensureReady, currentWeights, insertPick, insertRun, finishRun,
  openPicks, ageDays, recordProgress, closePick,
} from './db.js';
import { stockFactors, cryptoFactors } from './factors.js';
import { maybeLearn } from './learner.js';
import { scorePool } from './scorer.js';
import { fetchStockUniverse, fetchHistory, fetchLastPrice } from './sources/stocks.js';
import { fetchCryptoUniverse, fetchCryptoPrices, isDerivativeOrStable } from './sources/crypto.js';
import { log, mapLimit, mean, sampleN, std, clamp, quantile } from './util.js';

/**
 * The daily cycle, in order:
 *   1. TRACK  — mark every open pick to market, close picks past horizon
 *   2. LEARN  — retune factor weights from matured pick performance
 *   3. SCAN   — rebuild the stock + crypto universes, score, save new picks
 *
 * With { dry: true } only the SCAN half runs and nothing is written — used
 * to preview picks or to smoke-test data-source reachability in production.
 */
export async function runDaily({ dry = false } = {}) {
  await ensureReady();

  if (!dry) {
    const inFlight = await sql()`
      SELECT id FROM runs WHERE status = 'running' AND ts > now() - interval '15 minutes'`;
    if (inFlight.length) {
      log(`run #${inFlight[0].id} still in progress — skipping`);
      return { skipped: true, reason: `run #${inFlight[0].id} already in progress`, errors: [] };
    }
  }

  const runId = dry ? null : await insertRun();
  log(`=== daily run ${dry ? '(dry)' : '#' + runId} started ===`);

  const summary = { runId, dry, track: null, learn: {}, stocks: null, crypto: null, errors: [] };

  if (!dry) {
    try {
      summary.track = await trackOpenPicks();
    } catch (e) {
      summary.errors.push(`track: ${e.message}`);
      log('tracking failed:', e.message);
    }
    for (const assetClass of ['stock', 'crypto']) {
      try {
        summary.learn[assetClass] = await maybeLearn(assetClass);
      } catch (e) {
        summary.errors.push(`learn ${assetClass}: ${e.message}`);
      }
    }
  }

  try {
    summary.stocks = await scanStocks(runId, dry);
  } catch (e) {
    summary.errors.push(`stocks: ${e.message}`);
    log('stock scan failed:', e.message);
  }

  try {
    summary.crypto = await scanCrypto(runId, dry);
  } catch (e) {
    summary.errors.push(`crypto: ${e.message}`);
    log('crypto scan failed:', e.message);
  }

  const picksAdded = (summary.stocks?.picks?.length ?? 0) + (summary.crypto?.picks?.length ?? 0);
  if (!dry) {
    const status = picksAdded > 0 || summary.errors.length === 0 ? 'ok' : 'failed';
    await finishRun(runId, {
      status,
      stocksUniverse: summary.stocks?.universe ?? 0,
      cryptoUniverse: summary.crypto?.universe ?? 0,
      stocksCandidates: summary.stocks?.candidates ?? 0,
      cryptoCandidates: summary.crypto?.candidates ?? 0,
      picksAdded,
      marksAdded: summary.track?.marks ?? 0,
      picksClosed: summary.track?.closed ?? 0,
      notes: { learn: summary.learn, errors: summary.errors },
    });
    log(`=== daily run #${runId} ${status}: ${picksAdded} picks added ===`);
  } else {
    log(`=== dry run finished: would pick ${picksAdded} ===`);
  }
  return summary;
}

// ---------------------------------------------------------------- tracking

/** Which mark day (if any) is due for this pick and not yet recorded. */
async function dueMarkDay(pick, nowMs) {
  const age = Math.floor(ageDays(pick, nowMs));
  let due = null;
  for (const d of CONFIG.markDays) if (d <= age) due = d;
  if (due == null) return null;
  const rows = await sql()`SELECT MAX(age_days) AS m FROM marks WHERE pick_id = ${pick.id}`;
  return (rows[0]?.m ?? -1) < due ? age : null; // record at actual age, not the schedule slot
}

async function trackOpenPicks() {
  const now = Date.now();
  const picks = await openPicks();
  let marks = 0;
  let closed = 0;

  // Crypto: one batched request covers every open coin.
  const cryptoOpen = picks.filter((p) => p.asset_class === 'crypto');
  if (cryptoOpen.length) {
    const priceMap = await fetchCryptoPrices([...new Set(cryptoOpen.map((p) => p.source_id))]);
    for (const p of cryptoOpen) {
      const price = priceMap[p.source_id];
      if (!(price > 0)) continue;
      if (await recordProgress(p, price, await dueMarkDay(p, now))) marks++;
    }
  }

  // Stocks: only fetch symbols whose mark is due (keeps request volume sane).
  const stocksDue = [];
  for (const p of picks) {
    if (p.asset_class !== 'stock') continue;
    const due = await dueMarkDay(p, now);
    if (due != null) stocksDue.push({ pick: p, due });
  }
  await mapLimit(stocksDue, 5, async ({ pick, due }) => {
    const price = await fetchLastPrice(pick.source_id);
    if (price > 0 && (await recordProgress(pick, price, due))) marks++;
  });

  for (const p of picks) {
    if (ageDays(p, now) >= p.horizon_days) {
      await closePick(p);
      closed++;
    }
  }

  log(`tracking: ${picks.length} open picks, ${marks} marks recorded, ${closed} closed`);
  return { open: picks.length, marks, closed };
}

// ---------------------------------------------------------------- stocks

async function scanStocks(runId, dry) {
  const cfg = CONFIG.stocks;
  const universe = await fetchStockUniverse();
  log(`stocks: universe ${universe.length}`);

  const filtered = universe.filter(
    (r) =>
      r.price >= cfg.minPrice &&
      r.price <= cfg.maxPrice &&
      r.marketCap >= cfg.minMarketCap &&
      r.marketCap <= cfg.maxMarketCap &&
      r.price * (r.volume || 0) >= cfg.minDollarVolumeToday &&
      !cfg.junkName.test(r.name)
  );
  log(`stocks: ${filtered.length} pass hard filters`);
  if (filtered.length < 20) throw new Error('stock filter produced too few names');

  // Cheap pre-score from screener fields alone decides who gets a full
  // history fetch: today's move, today's dollar volume, small-cap tilt.
  const zOf = (vals) => {
    const finite = vals.filter(Number.isFinite).sort((a, b) => a - b);
    const lo = quantile(finite, 0.02), hi = quantile(finite, 0.98);
    const wins = finite.map((v) => clamp(v, lo, hi));
    const m = mean(wins), sd = std(wins) || 1e-9;
    return (v) => (Number.isFinite(v) ? clamp((clamp(v, lo, hi) - m) / sd, -4, 4) : 0);
  };
  const zPct = zOf(filtered.map((r) => r.pctChange));
  const zDv = zOf(filtered.map((r) => Math.log10(r.price * (r.volume || 0) + 1)));
  const zCap = zOf(filtered.map((r) => -Math.log10(r.marketCap)));
  for (const r of filtered) {
    r.preScore =
      0.5 * zPct(r.pctChange) +
      0.3 * zDv(Math.log10(r.price * (r.volume || 0) + 1)) +
      0.2 * zCap(-Math.log10(r.marketCap));
  }
  filtered.sort((a, b) => b.preScore - a.preScore);

  const shortlist = filtered.slice(0, cfg.candidates);
  const explorePool = sampleN(filtered.slice(cfg.candidates), cfg.exploreCandidates);
  const candidates = [...shortlist, ...explorePool];
  log(`stocks: fetching ${candidates.length} candidate histories`);

  const withBars = await mapLimit(candidates, 6, async (row) => ({
    row,
    bars: await fetchHistory(row.symbol),
  }));

  const pool = [];
  for (const item of withBars) {
    if (!item?.bars) continue;
    const factors = stockFactors(item.row, item.bars);
    if (!factors) continue;
    pool.push({
      row: item.row,
      factors,
      lastClose: item.bars[item.bars.length - 1].c,
    });
  }
  log(`stocks: ${pool.length} candidates scored`);
  if (!pool.length) throw new Error('no stock candidates had usable history');

  const { id: weightsId, weights } = await currentWeights('stock');
  scorePool(pool, weights);
  const picks = await selectAndInsert(runId, 'stock', pool, cfg, weightsId, dry, (p) => ({
    symbol: p.row.symbol,
    name: p.row.name,
    sourceId: p.row.symbol,
    entryPrice: p.lastClose,
    marketCap: p.row.marketCap,
  }));
  return { universe: universe.length, filtered: filtered.length, candidates: pool.length, picks };
}

// ---------------------------------------------------------------- crypto

async function scanCrypto(runId, dry) {
  const cfg = CONFIG.crypto;
  const universe = await fetchCryptoUniverse(cfg.pages);
  log(`crypto: universe ${universe.length}`);
  if (universe.length < 100) throw new Error('crypto universe fetch came back nearly empty');

  const pool = universe
    .filter(
      (c) =>
        c.current_price > 0 &&
        c.market_cap >= cfg.minMarketCap &&
        c.market_cap <= cfg.maxMarketCap &&
        c.total_volume >= cfg.minVolume &&
        !isDerivativeOrStable(c)
    )
    .map((c) => ({ row: c, factors: cryptoFactors(c), lastClose: c.current_price }));
  log(`crypto: ${pool.length} pass hard filters`);
  if (!pool.length) throw new Error('crypto filter produced no candidates');

  const { id: weightsId, weights } = await currentWeights('crypto');
  scorePool(pool, weights);
  const picks = await selectAndInsert(runId, 'crypto', pool, cfg, weightsId, dry, (p) => ({
    symbol: (p.row.symbol ?? '').toUpperCase(),
    name: p.row.name,
    sourceId: p.row.id,
    entryPrice: p.row.current_price,
    marketCap: p.row.market_cap,
  }));
  return { universe: universe.length, candidates: pool.length, picks };
}

// ---------------------------------------------------------------- selection

/**
 * Take the top N by score plus a few "explore" picks sampled from the next
 * tier. Explore picks feed the learner data outside the model's comfort
 * zone, so it can discover factors it currently underrates. Symbols with an
 * open pick are skipped rather than duplicated. In dry mode nothing is
 * inserted — the would-be picks are just returned.
 */
async function selectAndInsert(runId, assetClass, sortedPool, cfg, weightsId, dry, project) {
  const open = dry ? [] : await openPicks(assetClass);
  const openSymbols = new Set(open.map((p) => p.symbol));
  const available = sortedPool.filter((p) => !openSymbols.has(project(p).symbol));

  const chosen = available
    .slice(0, cfg.picksTop)
    .map((p, i) => ({ p, mode: 'top', rank: i + 1 }));
  const exploreTier = available.slice(cfg.picksTop, cfg.picksTop + 60);
  for (const p of sampleN(exploreTier, cfg.picksExplore)) {
    chosen.push({ p, mode: 'explore', rank: available.indexOf(p) + 1 });
  }

  const inserted = [];
  for (const { p, mode, rank } of chosen) {
    const base = project(p);
    if (!(base.entryPrice > 0)) continue;
    const id = dry
      ? null
      : await insertPick({
          runId,
          assetClass,
          mode,
          rank,
          score: p.score,
          factors: { raw: p.factors, z: p.z },
          weightsId,
          ...base,
        });
    inserted.push({ id, ...base, mode, rank, score: p.score });
  }
  log(`${assetClass}: ${dry ? 'would pick' : 'inserted'} ${inserted.length} — ${inserted.map((x) => x.symbol).join(', ')}`);
  return inserted;
}
