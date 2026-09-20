// api/admin-ban.js
// 管理者用BAN操作エンドポイント（単一POSTで action を指定する方式）
//
// POST /api/admin-ban
// body: { secret, action, playerId, reason }
//   action = "ban"    → playerId をBAN（reason省略可）
//   action = "unban"  → playerId のBANを解除
//   action = "list"   → BAN済み一覧を返す（playerId不要）
//
// 例（ブラウザのコンソールなどから）:
//   fetch('/api/admin-ban', {
//     method: 'POST',
//     headers: { 'Content-Type': 'application/json' },
//     body: JSON.stringify({ secret: 'あなたのADMIN_SECRET', action: 'ban', playerId: 'xxxx', reason: 'チート' })
//   }).then(r => r.json()).then(console.log)

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const ADMIN_SECRET = process.env.ADMIN_SECRET;

async function redis(command) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command)
  });
  return res.json();
}

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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

function checkAuth(secret) {
  return ADMIN_SECRET && secret === ADMIN_SECRET;
}

module.exports = async (req, res) => {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // GET も action=list として扱えるようにしておく（クエリパラメータ対応）
    const isGet = req.method === 'GET';
    const src = isGet ? (req.query || {}) : await readBody(req);
    const { secret, action, playerId, reason } = src;

    if (!checkAuth(secret)) {
      return res.status(403).json({ error: '認証エラー：secretが正しくありません' });
    }

    if (!action || !['ban', 'unban', 'list'].includes(action)) {
      return res.status(400).json({ error: 'action は ban / unban / list のいずれかを指定してください' });
    }

    if (action === 'list') {
      const banned = await redis(['smembers', 'banned_players']);
      return res.status(200).json({ success: true, bannedPlayers: banned.result || [] });
    }

    if (!playerId) {
      return res.status(400).json({ error: 'playerId が必要です' });
    }

    if (action === 'ban') {
      await redis(['sadd', 'banned_players', playerId]);
      await redis(['zrem', 'ranking', playerId]);
      if (reason) {
        await redis(['lpush', `flagged:${playerId}`, JSON.stringify({ reason: `manual_ban: ${reason}`, at: Date.now() })]);
      }
      return res.status(200).json({ success: true, message: `${playerId} をBANしました` });
    }

    if (action === 'unban') {
      await redis(['srem', 'banned_players', playerId]);
      return res.status(200).json({ success: true, message: `${playerId} のBANを解除しました` });
    }
  } catch (error) {
    console.error('[admin-ban]', error);
    return res.status(500).json({ error: error.message });
  }
};
