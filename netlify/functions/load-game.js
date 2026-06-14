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
    const { playerId } = event.queryStringParameters || {};
    if (!playerId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing playerId' }) };
    const result = await redis(['get', `save:${playerId}`]);
    if (!result.result) return { statusCode: 404, headers, body: JSON.stringify({ data: null, message: 'No save found' }) };
    const saveData = JSON.parse(result.result);
    return { statusCode: 200, headers, body: JSON.stringify({ data: saveData, success: true }) };
  } catch (error) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
