const https = require('https');

function redis(command) {
  return new Promise((resolve, reject) => {
    const url   = new URL(process.env.UPSTASH_REDIS_REST_URL);
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    const data  = JSON.stringify(command);
    const req   = https.request({
      hostname: url.hostname, port: 443,
      path: url.pathname + (url.search || ''),
      method: 'POST',
      headers: {
        'Authorization':  `Bearer ${token}`,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (r) => {
      let body = '';
      r.on('data', c => { body += c; });
      r.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const { playerId, saveData } = await readBody(req);
    if (!playerId || !saveData) return res.status(400).json({ error: 'Missing playerId or saveData' });

    // ─── BAN チェック ──────────────────────────────────
    const banCheck = await redis(['sismember', 'banned_players', playerId]);
    if (banCheck.result === 1) {
      console.warn(`[save-game] BANされたプレイヤーの保存試行: ${playerId}`);
      return res.status(403).json({ error: 'アカウントが停止されています', banned: true });
    }

    // ─── 保存 ──────────────────────────────────────────
    const dataToSave = { ...saveData, playerId, lastSaveTime: Date.now() };
    await redis(['set', `save:${playerId}`, JSON.stringify(dataToSave)]);
    return res.status(200).json({ success: true, timestamp: Date.now() });

  } catch (e) {
    console.error('[save-game]', e);
    return res.status(500).json({ error: e.message });
  }
};
