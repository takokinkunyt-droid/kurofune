const { redisRequest, redisPipeline, parseBody, CORS } = require('./_redis');

// セーブの削除口（ゲーム内の「セーブデータを消去」ボタン）。
//
// 直した点：
//  ・以前は無認証だったので、playerId を知っていれば他人のセーブを
//    消してランキングから外すこともできた → トークン照合を追加
//  ・消す前に履歴へ積むので、誤って押しても restore-save で戻せる
//  ・3本の del を1往復にまとめ、途中で切れて中途半端になるのを防ぐ

const REQUIRE_TOKEN = process.env.REQUIRE_SAVE_TOKEN === '1';

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'DELETE' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { playerId, saveToken } = await parseBody(req);
    if (!playerId) return res.status(400).json({ error: 'Missing playerId' });

    const valid = typeof saveToken === 'string' && saveToken.length >= 16 && saveToken.length <= 128;
    const stored = await redisRequest(['get', `token:${playerId}`]);
    if (stored.result) {
      if (valid ? stored.result !== saveToken : REQUIRE_TOKEN) {
        return res.status(403).json({ error: 'Save token mismatch', code: 'TOKEN_MISMATCH' });
      }
    } else if (REQUIRE_TOKEN && !valid) {
      return res.status(403).json({ error: 'Save token required', code: 'TOKEN_REQUIRED' });
    }

    const curRaw = await redisRequest(['get', `save:${playerId}`]);
    const commands = [];
    if (curRaw.result) {
      commands.push(['lpush', `save_hist:${playerId}`, curRaw.result]);
      commands.push(['ltrim', `save_hist:${playerId}`, 0, 19]);
    }
    commands.push(['del', `save:${playerId}`]);
    commands.push(['del', `player:${playerId}`]);
    commands.push(['zrem', 'ranking', playerId]);
    await redisPipeline(commands);

    return res.status(200).json({ success: true, message: 'Delete successful' });
  } catch (error) {
    console.error('[delete-save]', error.message);
    return res.status(500).json({ error: error.message });
  }
};
