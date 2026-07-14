import { getWeights } from '../src/queries.js';

export default async function handler(req, res) {
  try {
    res.status(200).json(await getWeights());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
