/**
 * /api/admin-ban  ─ BAN管理エンドポイント
 *
 * 環境変数 ADMIN_SECRET を設定してください（Vercelダッシュボード → Environment Variables）
 *
 * 使い方（ブラウザのコンソールやcurlから）:
 *   GET    /api/admin-ban?secret=<ADMIN_SECRET>              → BAN済みプレイヤー一覧
 *   POST   /api/admin-ban  body: { secret, playerId }        → 指定プレイヤーをBAN
 *   DELETE /api/admin-ban  body: { secret, playerId }        → BAN解除
 */
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
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

function authCheck(secret) {
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) return false;                          // 環境変数未設定はすべて拒否
  return secret === adminSecret;
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // ── GET: BAN済み一覧 ─────────────────────────────
    if (req.method === 'GET') {
      const { secret } = req.query || {};
      if (!authCheck(secret)) return res.status(403).json({ error: '認証エラー' });

      const result = await redis(['smembers', 'banned_players']);
      const banned = result.result || [];

      // プレイヤー名も取得して見やすく
      const details = await Promise.all(
        banned.map(async (id) => {
          const r = await redis(['get', `player:${id}`]);
          const data = r.result ? JSON.parse(r.result) : null;
          return { playerId: id, playerName: data?.playerName || '不明', score: data?.clickerScore || 0 };
        })
      );
      return res.status(200).json({ banned: details, count: details.length });
    }

    // ── POST: BANする ────────────────────────────────
    if (req.method === 'POST') {
      const { secret, playerId, reason } = await readBody(req);
      if (!authCheck(secret)) return res.status(403).json({ error: '認証エラー' });
      if (!playerId)          return res.status(400).json({ error: 'playerId が必要です' });

      await redis(['sadd', 'banned_players', playerId]);
      // ランキングからも除外
      await redis(['zrem', 'ranking', playerId]);
      // BAN理由をメモ
      if (reason) await redis(['set', `ban_reason:${playerId}`, reason]);

      console.log(`[admin-ban] BAN: ${playerId} reason: ${reason || 'なし'}`);
      return res.status(200).json({ success: true, message: `${playerId} をBANしました` });
    }

    // ── DELETE: BAN解除 ──────────────────────────────
    if (req.method === 'DELETE') {
      const { secret, playerId } = await readBody(req);
      if (!authCheck(secret)) return res.status(403).json({ error: '認証エラー' });
      if (!playerId)          return res.status(400).json({ error: 'playerId が必要です' });

      await redis(['srem', 'banned_players', playerId]);
      await redis(['del', `ban_reason:${playerId}`]);

      console.log(`[admin-ban] BAN解除: ${playerId}`);
      return res.status(200).json({ success: true, message: `${playerId} のBANを解除しました` });
    }

    return res.status(405).json({ error: 'Method Not Allowed' });
  } catch (e) {
    console.error('[admin-ban]', e);
    return res.status(500).json({ error: e.message });
  }
};
