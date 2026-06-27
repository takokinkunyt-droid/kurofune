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
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
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
    const { playerId, playerName, clickerScore, reincarnationCount, fragments } = await readBody(req);
    if (!playerId) return res.status(400).json({ error: 'Missing playerId' });

    // BANチェック
    const banCheck = await redis(['sismember', 'banned_players', playerId]);
    if (banCheck.result === 1) {
      return res.status(403).json({ error: 'アカウントが停止されています', banned: true });
    }

    const playerData = JSON.stringify({
      playerId,
      playerName: String(playerName || '名無しの船長').substring(0, 20),
      clickerScore: Math.floor(clickerScore || 0),
      reincarnationCount: reincarnationCount || 0,
      fragments: fragments || 0,
      updatedAt: Date.now(),
    });
    await redis(['zadd', 'ranking', Math.floor(clickerScore || 0), playerId]);
    await redis(['set', `player:${playerId}`, playerData]);
    return res.status(200).json({ success: true });
  } catch (e) {
    console.error('[update-ranking]', e);
    return res.status(500).json({ error: e.message });
  }
};
