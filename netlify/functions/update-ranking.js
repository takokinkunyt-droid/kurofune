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

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  try {
    const { playerId, playerName, clickerScore, reincarnationCount, fragments } = JSON.parse(event.body);
    if (!playerId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing playerId' }) };

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

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: 'Ranking updated' }) };
  } catch (error) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
