import { runDaily } from '../src/pipeline.js';

/**
 * Manual scan trigger from the dashboard. POST /api/scan runs a full cycle
 * synchronously (the runs-table guard in the pipeline prevents concurrent
 * duplicates). POST /api/scan?dry=1 previews picks without writing anything.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }
  try {
    const summary = await runDaily({ dry: req.query.dry === '1' });
    res.status(200).json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
