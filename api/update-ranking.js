const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(body) {
  const res = await fetch(`${REDIS_URL}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  return res.json();
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const { playerId, playerName, clickerScore, reincarnationCount, fragments } = req.body || {};
    if (!playerId) return res.status(400).json({ error: 'Missing playerId' });

    const playerData = JSON.stringify({
      playerId,
      playerName: playerName || '名無しの船長',
      clickerScore: Math.floor(clickerScore || 0),
      reincarnationCount: reincarnationCount || 0,
      fragments: fragments || 0,
      updatedAt: Date.now()
    });

    // ZADD: pipeline形式で送信
    await redis(['zadd', 'ranking', Math.floor(clickerScore || 0), playerId]);
    await redis(['set', `player:${playerId}`, playerData]);

    return res.status(200).json({ success: true, message: 'Ranking updated' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
