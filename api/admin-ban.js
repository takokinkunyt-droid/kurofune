/**
 * /api/admin-ban
 *
 * 合言葉（ADMIN_SECRET環境変数）で保護された、シャドウBAN管理用API。
 * ブラウザのコンソールや curl から直接叩いて使う想定。
 *
 * 使い方（ブラウザのコンソールから）:
 *
 *   // BANする
 *   fetch('/api/admin-ban', {
 *     method: 'POST',
 *     headers: { 'Content-Type': 'application/json' },
 *     body: JSON.stringify({ secret: 'ここに合言葉', playerId: 'BANしたいplayerId', action: 'ban' })
 *   }).then(r => r.json()).then(console.log);
 *
 *   // 解除する
 *   fetch('/api/admin-ban', {
 *     method: 'POST',
 *     headers: { 'Content-Type': 'application/json' },
 *     body: JSON.stringify({ secret: 'ここに合言葉', playerId: '対象のplayerId', action: 'unban' })
 *   }).then(r => r.json()).then(console.log);
 *
 *   // 現在シャドウBAN中の一覧を見る
 *   fetch('/api/admin-ban', {
 *     method: 'POST',
 *     headers: { 'Content-Type': 'application/json' },
 *     body: JSON.stringify({ secret: 'ここに合言葉', action: 'list' })
 *   }).then(r => r.json()).then(console.log);
 *
 * Vercelの Environment Variables に ADMIN_SECRET を設定しておくこと。
 */
const { redisRequest, CORS, parseBody } = require('./_redis');

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const body = await parseBody(req);
    const { secret, playerId, action } = body;

    const ADMIN_SECRET = process.env.ADMIN_SECRET;
    if (!ADMIN_SECRET) {
      return res.status(500).json({ error: 'ADMIN_SECRET が設定されていません（Vercelの環境変数を確認してください）' });
    }
    if (!secret || secret !== ADMIN_SECRET) {
      return res.status(403).json({ error: '合言葉が違います' });
    }

    if (action === 'list') {
      const result = await redisRequest(['smembers', 'shadow_banned_players']);
      return res.status(200).json({ success: true, banned: result.result || [] });
    }

    if (!playerId) return res.status(400).json({ error: 'playerId が必要です' });

    if (action === 'ban') {
      await redisRequest(['sadd', 'shadow_banned_players', playerId]);
      // 既にランキングに乗っている分は即座に非表示にする
      await redisRequest(['zrem', 'ranking', playerId]);
      return res.status(200).json({ success: true, message: `${playerId} をシャドウBANしました` });
    }

    if (action === 'unban') {
      await redisRequest(['srem', 'shadow_banned_players', playerId]);
      return res.status(200).json({ success: true, message: `${playerId} のBANを解除しました` });
    }

    return res.status(400).json({ error: 'action は ban / unban / list のいずれかを指定してください' });
  } catch (error) {
    console.error('[admin-ban]', error.message);
    return res.status(500).json({ error: error.message });
  }
};
