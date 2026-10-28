const { redisRequest, redisPipeline, parseBody, CORS } = require('./_redis');

// =====================================================================
// 加入プラン（江戸・明治・魁）
//
// お金は開発者が直接受け取り、管理コンソールから手で登録する。
// ここは「誰が・どのプランを・いつまで」を覚えておくだけ。
//
//  GET  ?playerId=<id>                    … 自分のプランと見た目（期限切れなら plan:null）
//  GET  ?action=supporters                … 魁プランで支えてくれた人の名前（殿堂用・公開）
//  GET  ?action=list&secret=…             … 加入者の一覧（管理）
//  GET  ?action=log&secret=…              … 登録の履歴（管理）
//  POST { playerId, saveToken, action:'style', style } … 見た目の保存（明治以上）
//  POST { secret, action:'grant',  playerId, plan, months } … 登録・延長（管理）
//  POST { secret, action:'revoke', playerId }               … 取り消し（管理）
// =====================================================================

const PLANS = { edo: 1, meiji: 2, sakigake: 3 };
const PLAN_NAMES = { edo: '江戸プラン', meiji: '明治プラン', sakigake: '魁プラン' };
const MONTH_MS = 30 * 24 * 3600 * 1000;
// 見た目は決まった選択肢だけ受け付ける（好きな文字列を入れられると、ランキングに何でも書けてしまう）
const STYLE_CHOICES = {
  color: ['default', 'gold', 'red', 'blue', 'green', 'purple', 'pink', 'orange', 'teal'],
  font:  ['default', 'mincho', 'dot', 'yusei', 'kurenaido'],
  plate: ['none', 'wood', 'gold', 'scroll', 'lantern'],
  theme: ['default', 'sakura', 'yuki', 'kogane'],
};

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();
  const SECRET = process.env.ADMIN_SECRET;

  try {
    if (req.method === 'GET') {
      const q = req.query || {};
      if (q.action === 'supporters') {
        const ids = (await redisRequest(['smembers', 'sakigake_supporters'])).result || [];
        const recs = ids.length ? await redisPipeline(ids.map(id => ['get', `player:${id}`])) : [];
        const names = recs.map(r => { try { return JSON.parse(r.result).playerName; } catch (e) { return null; } })
                          .filter(Boolean);
        return res.status(200).json({ success: true, names });
      }
      if (q.action === 'list' || q.action === 'log') {
        if (!SECRET || q.secret !== SECRET) return res.status(403).json({ error: 'Forbidden' });
        if (q.action === 'log') {
          const raw = (await redisRequest(['lrange', 'sub_log', 0, 199])).result || [];
          return res.status(200).json({ success: true, log: raw.map(s => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean) });
        }
        const ids = (await redisRequest(['smembers', 'subscribers'])).result || [];
        const recs = ids.length ? await redisPipeline(ids.flatMap(id => [['get', `sub:${id}`], ['get', `player:${id}`]])) : [];
        const list = ids.map((id, i) => {
          let sub = null, p = null;
          try { sub = JSON.parse(recs[i * 2].result); } catch (e) {}
          try { p = JSON.parse(recs[i * 2 + 1].result); } catch (e) {}
          return { playerId: id, name: p && p.playerName, plan: sub && sub.plan, until: sub && sub.until,
                   active: !!(sub && sub.until > Date.now()) };
        });
        return res.status(200).json({ success: true, list });
      }
      if (!q.playerId) return res.status(400).json({ error: 'Missing playerId' });
      const sub = await readSub(q.playerId);
      return res.status(200).json({ success: true, ...publicView(sub) });
    }

    if (req.method === 'POST') {
      const body = await parseBody(req);
      const playerId = body.playerId;
      if (!playerId || typeof playerId !== 'string' || playerId.length > 64) return res.status(400).json({ error: 'Bad playerId' });

      if (body.action === 'style') {
        if (!(await tokenOk(playerId, body.saveToken))) return res.status(403).json({ error: 'Token mismatch' });
        const sub = await readSub(playerId);
        const pv = publicView(sub);
        if (!pv.plan || PLANS[pv.plan] < PLANS.meiji) return res.status(403).json({ error: 'Plan required', need: 'meiji' });
        const st = Object.assign({}, sub.style || {});
        const inStyle = body.style || {};
        for (const k of Object.keys(STYLE_CHOICES)) {
          if (inStyle[k] != null) {
            if (!STYLE_CHOICES[k].includes(inStyle[k])) return res.status(400).json({ error: 'Bad ' + k });
            st[k] = inStyle[k];
          }
        }
        sub.style = st;
        await redisRequest(['set', `sub:${playerId}`, JSON.stringify(sub)]);
        return res.status(200).json({ success: true, style: st });
      }

      // ここから先は管理者だけ
      if (!SECRET || body.secret !== SECRET) return res.status(403).json({ error: 'Forbidden' });

      if (body.action === 'grant') {
        const plan = body.plan;
        if (!PLANS[plan]) return res.status(400).json({ error: 'Bad plan' });
        const months = Math.max(1, Math.min(12, parseInt(body.months, 10) || 1));
        const cur = await readSub(playerId);
        const now = Date.now();
        // 同じか上のプランが続いているなら、その期限に足す。それ以外は今日から。
        const base = (cur && cur.until > now && PLANS[cur.plan] >= PLANS[plan]) ? cur.until : now;
        const keepPlan = (cur && cur.until > now && PLANS[cur.plan] > PLANS[plan]) ? cur.plan : plan;
        const next = { plan: keepPlan, until: base + months * MONTH_MS, grantedAt: now, style: (cur && cur.style) || {} };
        const p = await redisRequest(['get', `player:${playerId}`]);
        let name = null; try { name = JSON.parse(p.result).playerName; } catch (e) {}
        const cmds = [
          ['set', `sub:${playerId}`, JSON.stringify(next)],
          ['sadd', 'subscribers', playerId],
          ['lpush', 'sub_log', JSON.stringify({ at: now, action: 'grant', playerId, name, plan, months, until: next.until })],
          ['ltrim', 'sub_log', 0, 999],
        ];
        if (plan === 'sakigake' || keepPlan === 'sakigake') cmds.push(['sadd', 'sakigake_supporters', playerId]);
        await redisPipeline(cmds);
        return res.status(200).json({ success: true, playerId, name, plan: next.plan, planName: PLAN_NAMES[next.plan],
                                      until: next.until, untilText: new Date(next.until).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' }) });
      }

      if (body.action === 'revoke') {
        const cur = await readSub(playerId);
        if (!cur) return res.status(404).json({ error: 'Not subscribed' });
        cur.until = Date.now() - 1;
        await redisPipeline([
          ['set', `sub:${playerId}`, JSON.stringify(cur)],
          ['lpush', 'sub_log', JSON.stringify({ at: Date.now(), action: 'revoke', playerId, plan: cur.plan })],
          ['ltrim', 'sub_log', 0, 999],
        ]);
        return res.status(200).json({ success: true, revoked: true });
      }

      return res.status(400).json({ error: 'Unknown action' });
    }

    return res.status(405).json({ error: 'Method Not Allowed' });
  } catch (error) {
    console.error('[sub]', error.message);
    return res.status(500).json({ error: error.message });
  }
};

async function readSub(playerId) {
  const r = await redisRequest(['get', `sub:${playerId}`]);
  if (!r.result) return null;
  try { return JSON.parse(r.result); } catch (e) { return null; }
}
function publicView(sub) {
  if (!sub || !(sub.until > Date.now()) || !PLANS[sub.plan]) return { plan: null, until: sub ? sub.until : null, style: {} };
  return { plan: sub.plan, level: PLANS[sub.plan], until: sub.until, style: sub.style || {} };
}
// 見た目の保存は、その人の端末からだけ受け付ける（セーブと同じ鍵）
async function tokenOk(playerId, saveToken) {
  const valid = typeof saveToken === 'string' && saveToken.length >= 16 && saveToken.length <= 128;
  if (!valid) return false;
  const stored = await redisRequest(['get', `token:${playerId}`]);
  return !stored.result || stored.result === saveToken;
}
module.exports.publicView = publicView;
