import { fetchJson, sleep, log } from '../util.js';

const API = 'https://api.coingecko.com/api/v3';

// Stablecoins can't 10x by construction.
const STABLE_SYMBOLS = new Set([
  'usdt', 'usdc', 'dai', 'tusd', 'usdd', 'usde', 'fdusd', 'pyusd', 'usds',
  'busd', 'frax', 'lusd', 'gusd', 'usdp', 'eurc', 'eurt', 'usdy', 'usd0',
  'rlusd', 'usd1', 'usdf', 'usdtb', 'susd', 'usdx', 'gho', 'crvusd',
  'eurq', 'eurs', 'eure', 'ageur', 'ceur', 'veur', 'eurr', 'xaut', 'paxg',
]);

/**
 * Top coins by market cap from CoinGecko's free API, 250 per page.
 * Momentum (24h/7d/30d) comes back in the same payload, so the whole crypto
 * side needs no per-coin requests. Paced to respect the free rate limit.
 */
export async function fetchCryptoUniverse(pages) {
  const all = [];
  for (let page = 1; page <= pages; page++) {
    const url =
      `${API}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250` +
      `&page=${page}&price_change_percentage=24h,7d,30d`;
    try {
      const json = await fetchJson(url, { retries: 4, backoffMs: 20000 });
      if (Array.isArray(json)) all.push(...json);
    } catch (e) {
      log(`coingecko page ${page} failed: ${e.message}`);
    }
    if (page < pages) await sleep(2600);
  }
  return all;
}

/**
 * Derivative listings (wrapped/staked/bridged) and stables track another
 * asset — their upside is not their own.
 */
export function isDerivativeOrStable(coin) {
  const name = (coin.name ?? '').toLowerCase();
  const sym = (coin.symbol ?? '').toLowerCase();
  if (STABLE_SYMBOLS.has(sym)) return true;
  if (/wrapped|staked|restaked|bridged|tokenized|(^|\s)peg/i.test(name)) return true;
  // Tokenized equities (xStocks, Backpack Securities, etc.) track a listed
  // stock — the stock scanner side already covers the underlying.
  if (/xstock|\([^)]*securities\)|pre.?ipo|onchain (stock|equity)/i.test(name)) return true;
  // Behaves like a peg even if unlisted above: sits near a round FX-ish
  // level and barely moves over a month (USD pegs ~1.00, EUR pegs ~1.0-1.3,
  // gold pegs excluded by symbol list).
  const mom30 = coin.price_change_percentage_30d_in_currency;
  if (
    coin.current_price > 0.9 &&
    coin.current_price < 1.35 &&
    mom30 != null &&
    Math.abs(mom30) < 4
  ) {
    return true;
  }
  return false;
}

/** Batch spot prices for open picks: { coingeckoId: usdPrice }. */
export async function fetchCryptoPrices(ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 250) {
    const chunk = ids.slice(i, i + 250);
    const url = `${API}/simple/price?ids=${encodeURIComponent(chunk.join(','))}&vs_currencies=usd`;
    try {
      const json = await fetchJson(url, { retries: 3, backoffMs: 20000 });
      for (const [id, v] of Object.entries(json ?? {})) {
        if (v?.usd > 0) out[id] = v.usd;
      }
    } catch (e) {
      log(`coingecko simple/price chunk failed: ${e.message}`);
    }
    if (i + 250 < ids.length) await sleep(2600);
  }
  return out;
}
