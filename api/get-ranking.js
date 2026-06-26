const { redisRequest, CORS } = require('./_redis');

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });
  try {
    const rankResult = await redisRequest(['zrevrange', 'ranking', 0, 99]);
    const playerIds = rankResult.result || [];
    if (!playerIds.length) return res.status(200).json({ data: [], count: 0, success: true });
    const players = await Promise.all(
      playerIds.map(async (id) => {
        const r = await redisRequest(['get', `player:${id}`]);
        return r.result ? JSON.parse(r.result) : null;
      })
    );
    const sorted = players.filter(Boolean);
    return res.status(200).json({ data: sorted, count: sorted.length, success: true });
  } catch (error) {
    console.error('[get-ranking]', error.message);
    return res.status(500).json({ error: error.message });
  }
};
