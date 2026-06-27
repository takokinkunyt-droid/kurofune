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

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
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

function authCheck(secret) {
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) return false;
  return secret === adminSecret;
}

module.exports = async (req, res) => {
  // CORSヘッダーを必ず最初にセット
  setCORS(res);

  // OPTIONSプリフライトは即200で返す（ここが重要）
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    if (req.method === 'GET') {
      const { secret } = req.query || {};
      if (!authCheck(secret)) return res.status(403).json({ error: '認証エラー' });

      const result = await redis(['smembers', 'banned_players']);
      const banned = result.result || [];
      const details = await Promise.all(
        banned.map(async (id) => {
          const r = await redis(['get', `player:${id}`]);
          const data = r.result ? JSON.parse(r.result) : null;
          const reasonR = await redis(['get', `ban_reason:${id}`]);
          return {
            playerId: id,
            playerName: data?.playerName || '不明',
            score: data?.clickerScore || 0,
            reason: reasonR.result || 'なし',
          };
        })
      );
      return res.status(200).json({ banned: details, count: details.length });
    }

    if (req.method === 'POST') {
      const { secret, playerId, reason } = await readBody(req);
      if (!authCheck(secret)) return res.status(403).json({ error: '認証エラー' });
      if (!playerId)          return res.status(400).json({ error: 'playerId が必要です' });

      await redis(['sadd', 'banned_players', playerId]);
      await redis(['zrem', 'ranking', playerId]);
      if (reason) await redis(['set', `ban_reason:${playerId}`, reason]);

      return res.status(200).json({ success: true, message: `${playerId} をBANしました` });
    }

    if (req.method === 'DELETE') {
      const { secret, playerId } = await readBody(req);
      if (!authCheck(secret)) return res.status(403).json({ error: '認証エラー' });
      if (!playerId)          return res.status(400).json({ error: 'playerId が必要です' });

      await redis(['srem', 'banned_players', playerId]);
      await redis(['del', `ban_reason:${playerId}`]);

      return res.status(200).json({ success: true, message: `${playerId} のBANを解除しました` });
    }

    return res.status(405).json({ error: 'Method Not Allowed' });
  } catch (e) {
    console.error('[admin-ban]', e);
    return res.status(500).json({ error: e.message });
  }
};
