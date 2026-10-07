const { redisRequest, redisPipeline, parseBody, CORS } = require('./_redis');

// =====================================================================
// セーブ履歴の閲覧と復元。
//
//  GET  /api/restore-save?playerId=<id>&action=list
//       → その人の履歴一覧（要約）。本人確認なしで見られるのは要約だけ。
//
//  GET  /api/restore-save?playerId=<id>&action=get&index=3
//       → 履歴の中身をそのまま返す（要 ADMIN_SECRET）。
//
//  POST /api/restore-save
//       { secret, playerId, index }           … 履歴 index を現役に戻す
//       { secret, playerId, saveData }        … 任意のセーブを書き込む
//       → いずれも要 ADMIN_SECRET
//
// 環境変数 ADMIN_SECRET を Vercel に設定しておくこと。
// =====================================================================

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SECRET = process.env.ADMIN_SECRET;

  try {
    if (req.method === 'GET') {
      const q = req.query || {};
      const playerId = q.playerId;
      const action = q.action || 'list';
      if (!playerId) return res.status(400).json({ error: 'Missing playerId' });

      const raw = await redisRequest(['lrange', `save_hist:${playerId}`, 0, 49]);
      const items = raw.result || [];

      if (action === 'list') {
        // 要約だけ返す。中身は出さない。
        const history = items.map((s, i) => {
          let o = {};
          try { o = JSON.parse(s); } catch (e) { return { index: i, broken: true }; }
          return {
            index: i,
            lastSaveTime: o.lastSaveTime,
            clickerScore: o.clickerScore,
            reincarnationCount: o.reincarnationCount,
            superReincarnationCount: o.superReincarnationCount,
            fragments: o.fragments,
            sakokuShards: o.sakokuShards,
            currentEra: o.currentEra,
            skillCount: countTrue(o.skills) + countTrue(o.superSkills),
            facilityCount: countFacilities(o.facilities),
            achievementCount: Object.values(o.achievements || {}).filter(a => a && a.unlocked).length,
          };
        });
        return res.status(200).json({ success: true, count: history.length, history });
      }

      if (action === 'get') {
        if (!SECRET || q.secret !== SECRET) return res.status(403).json({ error: 'Forbidden' });
        const idx = parseInt(q.index, 10);
        if (!(idx >= 0) || idx >= items.length) return res.status(404).json({ error: 'No such index' });
        return res.status(200).json({ success: true, data: JSON.parse(items[idx]) });
      }

      return res.status(400).json({ error: 'Unknown action' });
    }

    if (req.method === 'POST') {
      const body = await parseBody(req);
      if (!SECRET || body.secret !== SECRET) return res.status(403).json({ error: 'Forbidden' });

      const playerId = body.playerId;
      if (!playerId) return res.status(400).json({ error: 'Missing playerId' });

      let target = null;

      if (body.saveData) {
        target = body.saveData;
      } else if (body.index != null) {
        const raw = await redisRequest(['lrange', `save_hist:${playerId}`, 0, 49]);
        const items = raw.result || [];
        const idx = parseInt(body.index, 10);
        if (!(idx >= 0) || idx >= items.length) return res.status(404).json({ error: 'No such index' });
        target = JSON.parse(items[idx]);
      } else {
        return res.status(400).json({ error: 'Need index or saveData' });
      }

      // 復元する前に、いま入っているものも履歴に積む（復元の取り消し用）
      const curRaw = await redisRequest(['get', `save:${playerId}`]);
      const toWrite = { ...target, playerId, lastSaveTime: Date.now() };

      const commands = [];
      if (curRaw.result) {
        commands.push(['lpush', `save_hist:${playerId}`, curRaw.result]);
        commands.push(['ltrim', `save_hist:${playerId}`, 0, 19]);
      }
      commands.push(['set', `save:${playerId}`, JSON.stringify(toWrite)]);
      // ランキングも復元後の値に合わせる
      // ランキングは並び順（zset）と表示用の記録（player:<id>）の2つがある。
      // 片方だけ直すと、順位は正しいのに転生回数やかけらが古い値のまま表示される。
      commands.push(['zadd', 'ranking', Math.floor(Number(toWrite.clickerScore) || 0), playerId]);
      commands.push(['set', `player:${playerId}`, JSON.stringify({
        playerId,
        playerName: String(toWrite.playerName || '名無しの船長').substring(0, 20),
        clickerScore: Math.floor(Number(toWrite.clickerScore) || 0),
        reincarnationCount: Number(toWrite.reincarnationCount) || 0,
        fragments: Number(toWrite.fragments) || 0,
        era: eraLabelOf(toWrite),
        updatedAt: Date.now(),
      })]);
      await redisPipeline(commands);

      return res.status(200).json({
        success: true,
        restored: {
          clickerScore: toWrite.clickerScore,
          reincarnationCount: toWrite.reincarnationCount,
          fragments: toWrite.fragments,
          sakokuShards: toWrite.sakokuShards,
          currentEra: toWrite.currentEra,
          skillCount: countTrue(toWrite.skills) + countTrue(toWrite.superSkills),
          facilityCount: countFacilities(toWrite.facilities),
        },
      });
    }

    return res.status(405).json({ error: 'Method Not Allowed' });
  } catch (error) {
    console.error('[restore-save]', error.message);
    return res.status(500).json({ error: error.message });
  }
};

// セーブの状態からランキングに出す時代名を決める
function eraLabelOf(save) {
  if (save.currentEra === 'jomon') return '縄文時代';
  if (save.superSkills && save.superSkills.meijiRestoration) return '明治時代';
  if (save.skills && save.skills.kaikoku) return '江戸時代（開国）';
  return '江戸時代（初期）';
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function countTrue(o) { return (o && typeof o === 'object') ? Object.values(o).filter(Boolean).length : 0; }
function countFacilities(f) {
  if (!f || typeof f !== 'object') return 0;
  return Object.values(f).reduce((s, x) => s + num(x && x.count), 0);
}
