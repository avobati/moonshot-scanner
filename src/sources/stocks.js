import { fetchJson, JSON_HEADERS } from '../util.js';

const SCREENER_URL =
  'https://api.nasdaq.com/api/screener/stocks?limit=25000&offset=0&download=true';

function num(s) {
  if (s == null) return NaN;
  const v = parseFloat(String(s).replace(/[$,%\s]/g, ''));
  return Number.isFinite(v) ? v : NaN;
}

/**
 * Full US-listed universe (NASDAQ + NYSE + AMEX) from the NASDAQ screener —
 * one request, ~7000 symbols, no API key.
 */
export async function fetchStockUniverse() {
  const json = await fetchJson(SCREENER_URL, { retries: 4, backoffMs: 3000, timeoutMs: 60000 });
  const rows = json?.data?.rows ?? json?.data?.table?.rows ?? [];
  return rows
    .map((r) => ({
      symbol: (r.symbol ?? '').trim(),
      name: r.name ?? '',
      price: num(r.lastsale),
      pctChange: num(r.pctchange),
      volume: num(r.volume),
      marketCap: num(r.marketCap),
      sector: r.sector ?? '',
      industry: r.industry ?? '',
      ipoYear: r.ipoyear ?? '',
    }))
    .filter((r) => r.symbol && Number.isFinite(r.price) && r.price > 0);
}

/** NASDAQ screener uses BRK/A and X^Y styles; Yahoo wants dashes. */
export function toYahooSymbol(symbol) {
  return symbol.replace(/[/^]/g, '-');
}

/**
 * Daily OHLCV bars from Yahoo's chart endpoint. Returns an array of
 * { t, c, h, l, v } or null when the symbol has no usable data.
 */
export async function fetchHistory(symbol, range = '6mo') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    toYahooSymbol(symbol)
  )}?range=${range}&interval=1d`;
  const json = await fetchJson(url, { retries: 2, backoffMs: 2000 });
  const result = json?.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  if (!result || !quote) return null;
  const ts = result.timestamp ?? [];
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const c = quote.close?.[i];
    if (c == null || !(c > 0)) continue;
    bars.push({ t: ts[i], c, h: quote.high?.[i] ?? c, l: quote.low?.[i] ?? c, v: quote.volume?.[i] ?? 0 });
  }
  return bars.length ? bars : null;
}

/** Most recent close, used to mark open picks. */
export async function fetchLastPrice(symbol) {
  const bars = await fetchHistory(symbol, '5d').catch(() => null);
  return bars?.length ? bars[bars.length - 1].c : null;
}
