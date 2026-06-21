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
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    // スコア降順で上位100件のplayerIdを取得
    const rankResult = await redis(['zrevrange', 'ranking', 0, 99]);
    const playerIds = rankResult.result || [];

    if (playerIds.length === 0) {
      return res.status(200).json({ data: [], count: 0, success: true });
    }

    // 各プレイヤーの詳細データを取得
    const players = await Promise.all(
      playerIds.map(async (id) => {
        const r = await redis(['get', `player:${id}`]);
        return r.result ? JSON.parse(r.result) : null;
      })
    );

    const sorted = players.filter(Boolean);

    return res.status(200).json({ data: sorted, count: sorted.length, success: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
