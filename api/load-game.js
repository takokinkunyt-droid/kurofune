const { redisRequest, CORS } = require('./_redis');

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });
  try {
    const { playerId } = req.query || {};
    if (!playerId) return res.status(400).json({ error: 'Missing playerId' });
    const result = await redisRequest(['get', `save:${playerId}`]);
    if (!result.result) return res.status(404).json({ data: null });
    return res.status(200).json({ data: JSON.parse(result.result), success: true });
  } catch (error) {
    console.error('[load-game]', error.message);
    return res.status(500).json({ error: error.message });
  }
};
