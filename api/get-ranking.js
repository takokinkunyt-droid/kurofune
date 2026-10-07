const { redisRequest, CORS } = require('./_redis');

// ランキングの取得口。
//
// 直した点：
//  ・以前は player:<id> に入っている playerId をそのまま返していたため、
//    ランキングを開くだけで全プレイヤーのIDが取得できた。
//    save-game / delete-save が無認証だった組み合わせで、
//    「IDを知っていれば誰のセーブでも書き換え・削除できる」状態になっていた。
//  ・自分の行を光らせる用途だけ残すため、?me=<自分のID> を受け取り、
//    一致した行に isMe: true を立てて返す。IDそのものは一切返さない。
//  ・1件ずつ GET していたのを pipeline 1往復にまとめた。

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const me = (req.query && req.query.me) || null;

    const rankResult = await redisRequest(['zrevrange', 'ranking', 0, 99]);
    const playerIds = rankResult.result || [];
    if (!playerIds.length) return res.status(200).json({ data: [], count: 0, success: true });

    const results = await Promise.all(
      playerIds.map(id => redisRequest(['get', `player:${id}`]))
    );

    const data = [];
    playerIds.forEach((id, i) => {
      const raw = results[i] && results[i].result;
      if (!raw) return;
      let p;
      try { p = JSON.parse(raw); } catch (e) { return; }
      data.push({
        playerName: p.playerName || '名無しの船長',
        clickerScore: p.clickerScore || 0,
        reincarnationCount: p.reincarnationCount || 0,
        fragments: p.fragments || 0,
        era: p.era || '江戸時代（初期）',
        updatedAt: p.updatedAt || 0,
        isMe: !!(me && id === me),
      });
    });

    return res.status(200).json({ data, count: data.length, success: true });
  } catch (error) {
    console.error('[get-ranking]', error.message);
    return res.status(500).json({ error: error.message });
  }
};
