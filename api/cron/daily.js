import { runDaily } from '../../src/pipeline.js';

/**
 * Vercel Cron entry point — schedule lives in vercel.json. When CRON_SECRET
 * is set (recommended), Vercel sends it as a bearer token and manual
 * requests without it are rejected.
 */
export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const summary = await runDaily();
    res.status(200).json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
