const { redisRequest, CORS, parseBody } = require('./_redis');

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method Not Allowed' });
  try {
    const body = await parseBody(req);
    const { playerId } = body;
    if (!playerId) return res.status(400).json({ error: 'Missing playerId' });
    await redisRequest(['del', `save:${playerId}`]);
    await redisRequest(['del', `player:${playerId}`]);
    await redisRequest(['zrem', 'ranking', playerId]);
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('[delete-save]', error.message);
    return res.status(500).json({ error: error.message });
  }
};
