const { redisRequest, CORS } = require('./_redis');

// セーブの読み出し口。
//
// 「消えたら戻す」ではなく「消えたことにさせない」ための最後の砦。
// 保存されているセーブが
//   ・存在しない
//   ・壊れていて読めない
//   ・初期状態（施設0・スキル0・転生0）
// のどれかで、履歴（save_hist）に中身のあるセーブが残っているなら、
// そちらを返す。プレイヤーから見ると何も失われていない。
// 治したときは現役のセーブにも書き戻し、記録を残す。

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const { playerId } = req.query || {};
    if (!playerId) return res.status(400).json({ error: 'Missing playerId' });

    const result = await redisRequest(['get', `save:${playerId}`]);

    let current = null;
    let problem = null;
    if (result.result === null || result.result === undefined) {
      problem = 'missing';
    } else {
      try { current = JSON.parse(result.result); } catch (e) { problem = 'corrupt'; }
      if (current && (typeof current !== 'object' || !current.facilities)) { problem = 'incomplete'; current = null; }
      if (current && isBlank(current)) problem = 'blank';
    }

    if (!problem) {
      return res.status(200).json({ data: current, success: true });
    }

    // 履歴から中身のある一番新しいものを探す
    const histRaw = await redisRequest(['lrange', `save_hist:${playerId}`, 0, 49]);
    const hist = histRaw.result || [];
    let healed = null;
    for (const raw of hist) {
      let o; try { o = JSON.parse(raw); } catch (e) { continue; }
      if (o && o.facilities && !isBlank(o)) { healed = o; break; }
    }

    if (healed) {
      // 本当の転生（縄文時代）を選んだ人の初期状態は正常なので治さない
      if (problem === 'blank' && current && current.currentEra === 'jomon') {
        return res.status(200).json({ data: current, success: true });
      }
      // ただし履歴のほうが古い時代なら、それは意図したリセット（シーズン切り替え）の後。
      if (problem === 'blank' && current && current.saveVersion !== healed.saveVersion) {
        return res.status(200).json({ data: current, success: true });
      }

      const restored = { ...healed, playerId, lastSaveTime: Date.now() };
      await redisRequest(['set', `save:${playerId}`, JSON.stringify(restored)]);
      try {
        await redisRequest(['lpush', 'save_heal_log',
          JSON.stringify({ playerId, at: Date.now(), problem,
                           restoredScore: healed.clickerScore })]);
        await redisRequest(['ltrim', 'save_heal_log', 0, 299]);
      } catch (e) {}
      console.warn('[load-game] healed', playerId, problem);
      return res.status(200).json({ data: restored, success: true, healed: problem });
    }

    // 治せる履歴が無い
    if (problem === 'missing') return res.status(404).json({ data: null, message: 'No save found' });
    if (problem === 'blank')   return res.status(200).json({ data: current, success: true });
    return res.status(500).json({ error: 'Save is unreadable', code: problem.toUpperCase() });
  } catch (error) {
    console.error('[load-game]', error.message);
    return res.status(500).json({ error: error.message });
  }
};

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function countTrue(o) { return (o && typeof o === 'object') ? Object.values(o).filter(Boolean).length : 0; }
function countFacilities(f) {
  if (!f || typeof f !== 'object') return 0;
  return Object.values(f).reduce((s, x) => s + num(x && x.count), 0);
}
function isBlank(d) {
  if (d.currentEra === 'jomon') return false;
  return countFacilities(d.facilities) === 0 &&
         countTrue(d.skills) === 0 && countTrue(d.superSkills) === 0 &&
         num(d.reincarnationCount) === 0 && num(d.superReincarnationCount) === 0;
}
