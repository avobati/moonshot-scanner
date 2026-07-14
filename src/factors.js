import { mean, std, clamp } from './util.js';

/**
 * Factor vector for a stock from ~6 months of daily bars plus the screener
 * row. Returns null when there isn't enough history to be meaningful.
 * All factors are raw values here; cross-sectional z-scoring happens in the
 * scorer against the day's candidate pool.
 */
export function stockFactors(row, bars) {
  if (!bars || bars.length < 25) return null;
  const closes = bars.map((b) => b.c);
  const highs = bars.map((b) => b.h);
  const vols = bars.map((b) => b.v);
  const n = closes.length;
  const last = closes[n - 1];
  const closeAgo = (k) => closes[Math.max(0, n - 1 - k)];

  // ~22 / ~5 trading days ≈ 30 / 7 calendar days
  const mom30 = last / closeAgo(22) - 1;
  const mom7 = last / closeAgo(5) - 1;
  const accel = mom7 - mom30 * (5 / 22);

  const recentVol = mean(vols.slice(-5));
  const baseVol = mean(vols.slice(-45, -5));
  const volSurge = recentVol > 0 && baseVol > 0 ? Math.log(recentVol / baseVol) : 0;

  const high6mo = Math.max(...highs);
  const breakout = high6mo > 0 ? last / high6mo : 0;

  const logRets = [];
  for (let i = Math.max(1, n - 30); i < n; i++) {
    if (closes[i - 1] > 0) logRets.push(Math.log(closes[i] / closes[i - 1]));
  }
  const volatility = std(logRets);

  const microCap =
    Number.isFinite(row.marketCap) && row.marketCap > 0 ? -Math.log10(row.marketCap) : 0;

  const avgDollarVol = mean(bars.slice(-20).map((b) => b.c * b.v));
  const dollarVol = avgDollarVol > 0 ? Math.log10(avgDollarVol) : 0;

  return { volSurge, mom30, mom7, accel, breakout, volatility, microCap, dollarVol };
}

/**
 * Factor vector for a coin straight from the CoinGecko markets row —
 * no extra requests needed.
 */
export function cryptoFactors(coin) {
  const mc = coin.market_cap;
  const mom30 = (coin.price_change_percentage_30d_in_currency ?? 0) / 100;
  const mom7 = (coin.price_change_percentage_7d_in_currency ?? 0) / 100;
  const mom24 =
    (coin.price_change_percentage_24h_in_currency ?? coin.price_change_percentage_24h ?? 0) / 100;
  const accel = mom7 - mom30 * (7 / 30);
  const turnover = mc > 0 ? clamp(coin.total_volume / mc, 0, 3) : 0;
  const microCap = mc > 0 ? -Math.log10(mc) : 0;
  const athDist = clamp(1 + (coin.ath_change_percentage ?? -100) / 100, 0, 1);
  return { turnover, mom30, mom7, mom24, accel, microCap, athDist };
}
