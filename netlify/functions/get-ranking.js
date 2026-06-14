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
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  try {
    // スコア降順で上位100件のplayerIdを取得
    const rankResult = await redis(['zrevrange', 'ranking', 0, 99]);
    const playerIds = rankResult.result || [];

    if (playerIds.length === 0) {
      return { statusCode: 200, headers, body: JSON.stringify({ data: [], count: 0, success: true }) };
    }

    // 各プレイヤーの詳細データを取得
    const players = await Promise.all(
      playerIds.map(async (id) => {
        const r = await redis(['get', `player:${id}`]);
        return r.result ? JSON.parse(r.result) : null;
      })
    );

    const sorted = players.filter(Boolean);

    return { statusCode: 200, headers, body: JSON.stringify({ data: sorted, count: sorted.length, success: true }) };
  } catch (error) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
