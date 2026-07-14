import http from 'node:http';
import fs from 'node:fs';
import { CONFIG } from './config.js';
import { latestCompletedRun, ensureReady } from './db.js';
import { runDaily } from './pipeline.js';
import { getSummary, getLatestPicks, getHistory, getWeights } from './queries.js';
import { log } from './util.js';

/**
 * Local development server. Production uses the api/ serverless functions —
 * both share src/queries.js so the endpoints behave identically.
 */

let scanInFlight = false;

async function runScan(opts) {
  scanInFlight = true;
  try {
    return await runDaily(opts);
  } finally {
    scanInFlight = false;
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(CONFIG.htmlPath));
    } else if (url.pathname === '/api/summary') {
      sendJson(res, 200, await getSummary());
    } else if (url.pathname === '/api/picks/latest') {
      sendJson(res, 200, await getLatestPicks());
    } else if (url.pathname === '/api/picks/history') {
      sendJson(res, 200, await getHistory(url.searchParams.get('limit')));
    } else if (url.pathname === '/api/weights') {
      sendJson(res, 200, await getWeights());
    } else if (url.pathname === '/api/scan' && req.method === 'POST') {
      if (scanInFlight) {
        sendJson(res, 409, { error: 'a scan is already running' });
      } else {
        const summary = await runScan({ dry: url.searchParams.get('dry') === '1' });
        sendJson(res, 200, summary);
      }
    } else if (url.pathname === '/api/scan/status') {
      sendJson(res, 200, { running: scanInFlight });
    } else {
      sendJson(res, 404, { error: 'not found' });
    }
  } catch (e) {
    log('request error:', req.url, e.message);
    sendJson(res, 500, { error: e.message });
  }
});

server.listen(CONFIG.port, async () => {
  log(`Moonshot Scanner dashboard: http://localhost:${CONFIG.port}`);
  // Keep the data fresh without a scheduler: if the newest completed run is
  // stale, kick a scan in the background on startup.
  try {
    await ensureReady();
    const run = await latestCompletedRun();
    const ageHours = run ? (Date.now() - new Date(run.ts).getTime()) / 3600000 : Infinity;
    if (ageHours > CONFIG.staleHours) {
      log(`last completed run is ${run ? ageHours.toFixed(1) + 'h old' : 'missing'} — starting scan`);
      runScan({}).catch((e) => log('startup scan failed:', e.message));
    }
  } catch (e) {
    log('staleness check failed:', e.message);
  }
});
