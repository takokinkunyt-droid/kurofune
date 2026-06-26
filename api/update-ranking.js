const { redisRequest, CORS, parseBody } = require('./_redis');

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  try {
    const body = await parseBody(req);
    const { playerId, playerName, clickerScore, reincarnationCount, fragments } = body;
    if (!playerId) return res.status(400).json({ error: 'Missing playerId' });
    const playerData = JSON.stringify({
      playerId,
      playerName: String(playerName || '名無しの船長').substring(0, 20),
      clickerScore: Math.floor(clickerScore || 0),
      reincarnationCount: reincarnationCount || 0,
      fragments: fragments || 0,
      updatedAt: Date.now(),
    });
    await redisRequest(['zadd', 'ranking', Math.floor(clickerScore || 0), playerId]);
    await redisRequest(['set', `player:${playerId}`, playerData]);
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('[update-ranking]', error.message);
    return res.status(500).json({ error: error.message });
  }
};
