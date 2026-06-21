const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(body) {
  const res = await fetch(`${REDIS_URL}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
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
    const { playerId } = req.query || {};
    if (!playerId) return res.status(400).json({ error: 'Missing playerId' });
    const result = await redis(['get', `save:${playerId}`]);
    if (!result.result) return res.status(404).json({ data: null, message: 'No save found' });
    const saveData = JSON.parse(result.result);
    return res.status(200).json({ data: saveData, success: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
