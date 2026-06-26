const { redisRequest, CORS, parseBody } = require('./_redis');

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  try {
    const body = await parseBody(req);
    const { playerId, saveData } = body;
    if (!playerId || !saveData) return res.status(400).json({ error: 'Missing playerId or saveData' });
    const dataToSave = { ...saveData, playerId, lastSaveTime: Date.now() };
    await redisRequest(['set', `save:${playerId}`, JSON.stringify(dataToSave)]);
    return res.status(200).json({ success: true, timestamp: Date.now() });
  } catch (error) {
    console.error('[save-game]', error.message);
    return res.status(500).json({ error: error.message });
  }
};
