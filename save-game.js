const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(command, ...args) {
  const res = await fetch(`${REDIS_URL}/${command}/${args.map(a => encodeURIComponent(a)).join('/')}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
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
    const { playerId, saveData } = JSON.parse(event.body);
    if (!playerId || !saveData) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing playerId or saveData' }) };

    const dataToSave = { ...saveData, playerId, lastSaveTime: Date.now() };
    await redis('set', `save:${playerId}`, JSON.stringify(dataToSave));

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: 'Save successful', timestamp: Date.now() }) };
  } catch (error) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
