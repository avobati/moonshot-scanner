import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.js';

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export const JSON_HEADERS = {
  'User-Agent': UA,
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function nowIso() {
  return new Date().toISOString();
}

export function log(...args) {
  const line = `[${nowIso()}] ${args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(CONFIG.logPath), { recursive: true });
    fs.appendFileSync(CONFIG.logPath, line + '\n');
  } catch {
    // logging must never take the pipeline down
  }
}

/**
 * fetch → JSON with retries and exponential backoff. Retries on network
 * errors, 429 and 5xx. Throws after exhausting retries.
 */
export async function fetchJson(url, { headers = JSON_HEADERS, retries = 3, backoffMs = 1500, timeoutMs = 30000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
      } else if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      } else {
        return await res.json();
      }
    } catch (e) {
      lastErr = e;
      if (e.message?.startsWith('HTTP 4') && !e.message.includes('429')) throw e;
    }
    if (attempt < retries) await sleep(backoffMs * (attempt + 1) * (1 + Math.random() * 0.3));
  }
  throw lastErr ?? new Error('fetch failed');
}

/** Run fn over items with bounded concurrency; failed items resolve to null. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length).fill(null);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch {
        results[i] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---------- small stats toolkit ----------

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const round4 = (v) => Math.round(v * 10000) / 10000;

export function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

export function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1));
}

/** p-quantile of a pre-sorted ascending array. */
export function quantile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = clamp(p, 0, 1) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** Average ranks (1-based); ties get the mean of their positions. */
export function ranks(arr) {
  const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(arr.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k][1]] = avg;
    i = j + 1;
  }
  return out;
}

export function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const ma = mean(a), mb = mean(b);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  const den = Math.sqrt(da * db);
  return den > 1e-12 ? num / den : 0;
}

/** Spearman rank correlation — robust to the fat tails of moonshot returns. */
export function spearman(a, b) {
  return pearson(ranks(a), ranks(b));
}

/** Sample n items uniformly without replacement. */
export function sampleN(arr, n) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}
