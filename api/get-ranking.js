const { redisRequest, redisPipeline, CORS } = require('./_redis');
const LV = require('./_level');
const SS = require('./_substyle');

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
    if (req.query && req.query.type === 'level') return levelRanking(req, res, me);

    const [rankResult, hiddenResult] = await Promise.all([
      redisRequest(['zrevrange', 'ranking', 0, 99]),
      redisRequest(['smembers', 'ranking_hidden_players']),
    ]);
    const hiddenSet = new Set(hiddenResult.result || []);
    const playerIds = (rankResult.result || []).filter(id => !hiddenSet.has(id));
    if (!playerIds.length) return res.status(200).json({ data: [], count: 0, success: true });

    const results = await Promise.all(
      playerIds.map(id => redisRequest(['get', `player:${id}`]))
    );
    // 加入プランの見た目（名前の色・フォント・札・魁の印）
    const subs = await Promise.all(playerIds.map(id => redisRequest(['get', `sub:${id}`])));

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
        sub: subView(subs[i] && subs[i].result),
      });
    });

    return res.status(200).json({ data, count: data.length, success: true });
  } catch (error) {
    console.error('[get-ranking]', error.message);
    return res.status(500).json({ error: error.message });
  }
};

// レベルのランキング（隻数とは別。シーズンごとに0から）
async function levelRanking(req, res, me) {
  const [rankResult, hiddenResult] = await redisPipeline([
    ['zrevrange', LV.LEVEL_KEY, 0, 99, 'WITHSCORES'],
    ['smembers', 'ranking_hidden_players'],
  ]);
  const hiddenSet = new Set(hiddenResult.result || []);
  const flat = rankResult.result || [];
  const rows = [];
  for (let i = 0; i + 1 < flat.length; i += 2) if (!hiddenSet.has(flat[i])) rows.push({ id: flat[i], exp: Number(flat[i + 1]) || 0 });
  if (!rows.length) return res.status(200).json({ data: [], count: 0, success: true });
  const recs = await redisPipeline(rows.flatMap(r => [['get', `player:${r.id}`], ['get', `sub:${r.id}`]]));
  const data = rows.map((r, i) => {
    let p = null; try { p = JSON.parse(recs[i * 2].result); } catch (e) {}
    const lv = LV.levelFromExp(r.exp);
    return { playerName: (p && p.playerName) || '名無しの船長', exp: r.exp, level: lv.level,
             isMe: !!(me && r.id === me), sub: subView(recs[i * 2 + 1].result) };
  });
  return res.status(200).json({ data, count: data.length, success: true });
}

const PLAN_LEVEL = { edo: 1, meiji: 2, sakigake: 3, cho: 4 };
function subView(raw) {
  if (!raw) return null;
  let s; try { s = JSON.parse(raw); } catch (e) { return null; }
  if (!s || !(s.until > Date.now()) || !PLAN_LEVEL[s.plan]) return null;
  const st = s.style || {};
  // 見た目は明治から。江戸は印だけ返さない（広告が消えるだけのプラン）
  if (PLAN_LEVEL[s.plan] < 2) return null;
  const e = SS.effectiveStyle(st, s.plan);   // 今のプランで使えない選択は「ふつう」で出す
  return { plan: s.plan, color: e.color, font: e.font, plate: e.plate };
}
