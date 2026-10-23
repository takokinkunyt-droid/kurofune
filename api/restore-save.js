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

      // playerId を必要としないアクションは、必須チェックより先に処理する。
      // ここを後ろに置いていたため status と whois が 400 になり、
      // 管理画面が「ADMIN_SECRET が未設定」と誤表示していた。
      if (action === 'status' || action === 'whois') {
        return await handleKeylessGet(action, q, res, SECRET);
      }
      if (action === 'inspect' || action === 'rejects') {
        if (!SECRET || q.secret !== SECRET) return res.status(403).json({ error: 'Forbidden' });
        return action === 'inspect' ? await inspectPlayer(q.playerId, res) : await recentLogs(res);
      }

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

      if (body.action === 'resync') {
        const r = await resyncRanking(playerId);
        return res.status(r.ok ? 200 : 404).json(r);
      }
      // ランキングから外す／戻す（セーブはそのまま）
      if (body.action === 'hide') {
        await redisPipeline([
          ['sadd', 'ranking_hidden_players', playerId],
          ['zrem', 'ranking', playerId],
        ]);
        return res.status(200).json({ success: true, hidden: true });
      }
      if (body.action === 'unhide') {
        await redisRequest(['srem', 'ranking_hidden_players', playerId]);
        const r = await resyncRanking(playerId);
        return res.status(200).json({ success: true, hidden: false, resync: r });
      }
      if (body.action === 'unshadow') {
        await redisPipeline([
          ['srem', 'shadow_banned_players', playerId],
          ['srem', 'banned_players', playerId],
        ]);
        const r = await resyncRanking(playerId);
        return res.status(200).json({ success: true, unbanned: true, resync: r });
      }

      let target = null;

      // 補填用：いまのセーブを土台に、指定した項目だけを書き換える。
      // 全体を payload で組み直すと、今回のように superSkills を
      // 立て忘れて別の事故を起こすので、必要な項目だけ触れるようにする。
      if (body.action === 'patch') {
        const curRaw0 = await redisRequest(['get', `save:${playerId}`]);
        if (!curRaw0.result) return res.status(404).json({ error: 'No current save to patch' });
        let cur;
        try { cur = JSON.parse(curRaw0.result); }
        catch (e) { return res.status(500).json({ error: 'Current save is corrupt' }); }

        const set = body.set || {};
        const applied = {};

        // 数値項目は許可したものだけ
        const NUMERIC = ['clickerScore', 'currentLifeScore', 'fragments', 'sakokuShards',
                         'reincarnationCount', 'superReincarnationCount',
                         'bTicket', 'pTicket'];
        for (const k of NUMERIC) {
          if (set[k] != null) {
            const n = Number(set[k]);
            if (!Number.isFinite(n) || n < 0) {
              return res.status(400).json({ error: `Bad value for ${k}` });
            }
            cur[k] = n;
            applied[k] = n;
          }
        }
        // clickerScore だけ指定された場合は currentLifeScore も揃える。
        // 片方だけ直すと次の転生でおかしな量のかけらが入る。
        if (set.clickerScore != null && set.currentLifeScore == null) {
          cur.currentLifeScore = Number(set.clickerScore);
          applied.currentLifeScore = cur.currentLifeScore;
        }

        // 昇天・超昇天アップグレードの個別指定（true のみ受け付ける）
        for (const group of ['skills', 'superSkills']) {
          if (set[group] && typeof set[group] === 'object') {
            cur[group] = Object.assign({}, cur[group]);
            applied[group] = [];
            for (const k of Object.keys(set[group])) {
              if (set[group][k] === true && k in cur[group]) {
                cur[group][k] = true;
                applied[group].push(k);
              }
            }
          }
        }

        // 「If」を持っていて「持ち越し」が無い状態は、次の転生で
        // 隻数が全部消える組み合わせ。補填でそれを渡さないよう弾く。
        if (cur.skills && cur.skills.ifSkill &&
            cur.superSkills && !cur.superSkills.carryOver &&
            Number(cur.clickerScore) > 1e9 && body.allowCarryOverTrap !== true) {
          return res.status(409).json({
            error: 'This would hand the player a destructive super-reincarnation',
            code: 'CARRYOVER_TRAP',
            hint: 'set.superSkills.carryOver = true を足すか、承知のうえなら allowCarryOverTrap: true を付ける',
          });
        }

        target = cur;
      } else if (body.saveData) {
        target = body.saveData;
      } else if (body.index != null) {
        const raw = await redisRequest(['lrange', `save_hist:${playerId}`, 0, 49]);
        const items = raw.result || [];
        const idx = parseInt(body.index, 10);
        if (!(idx >= 0) || idx >= items.length) return res.status(404).json({ error: 'No such index' });
        target = JSON.parse(items[idx]);
      } else {
        return res.status(400).json({ error: "Need action:'patch', or index, or saveData" });
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
      const hiddenNow = await redisRequest(['sismember', 'ranking_hidden_players', playerId]);
      if (hiddenNow.result !== 1) {
        commands.push(['zadd', 'ranking', rankScoreOf(toWrite), playerId]);
      }
      commands.push(['set', `player:${playerId}`, JSON.stringify({
        playerId,
        playerName: String(toWrite.playerName || '名無しの船長').substring(0, 20),
        clickerScore: rankScoreOf(toWrite),
        reincarnationCount: Number(toWrite.reincarnationCount) || 0,
        fragments: Number(toWrite.fragments) || 0,
        era: eraLabelOf(toWrite),
        updatedAt: Date.now(),
      })]);
      await redisPipeline(commands);

      return res.status(200).json({
        success: true,
        mode: body.action === 'patch' ? 'patch' : (body.saveData ? 'saveData' : 'index'),
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

// playerId を必要としない GET アクション。
// status は鍵が設定されているか、whois は名前から playerId を引く。
async function handleKeylessGet(action, q, res, SECRET) {
    if (action === 'status') {
      // ADMIN_SECRET が設定されているかだけを返す。鍵そのものは絶対に返さない。
      // 「環境変数の未設定」と「鍵の不一致」を切り分けるための入口。
      return res.status(200).json({
        success: true,
        adminSecretConfigured: !!SECRET,
        secretLength: SECRET ? SECRET.length : 0,
        hint: SECRET
          ? 'ADMIN_SECRET は設定済み。Forbidden が出るなら送っている鍵が違う。'
          : 'ADMIN_SECRET が未設定、または設定後に Redeploy していない。',
      });
    }

    if (action === 'whois') {
      // 管理者用の名前検索。
      // get-ranking から playerId を取り除いたので（他人のセーブを
      // 書き換えられる穴を塞ぐため）、補填先を名前から引けなくなった。
      // 鍵を持っている人だけが引けるようにする。
      if (!SECRET || q.secret !== SECRET) return res.status(403).json({ error: 'Forbidden' });
      const needle = String(q.name || '').trim();
      if (!needle) return res.status(400).json({ error: 'Missing name' });

      const rank = await redisRequest(['zrevrange', 'ranking', 0, 999]);
      const ids = rank.result || [];
      const rows = await Promise.all(ids.map(id => redisRequest(['get', `player:${id}`])));

      const hits = [];
      ids.forEach((id, i) => {
        const raw = rows[i] && rows[i].result;
        if (!raw) return;
        let p; try { p = JSON.parse(raw); } catch (e) { return; }
        const name = String(p.playerName || '');
        if (name === needle || name.includes(needle)) {
          hits.push({
            playerId: id,
            playerName: name,
            exact: name === needle,
            clickerScore: p.clickerScore,
            reincarnationCount: p.reincarnationCount,
            fragments: p.fragments,
            era: p.era,
            rankingUpdatedAt: p.updatedAt,
          });
        }
      });
      return res.status(200).json({ success: true, query: needle, count: hits.length, hits });
    }

  return res.status(400).json({ error: 'Unknown action' });
}

// ---- 診断：1人のセーブとランキングの食い違いを丸ごと見る ----
async function inspectPlayer(playerId, res) {
  if (!playerId) return res.status(400).json({ error: 'Missing playerId' });
  const [saveR, zR, pR, banR, shR, tokR, hlR, histR, rejR, healR, hidR] = await redisPipeline([
    ['get', `save:${playerId}`],
    ['zscore', 'ranking', playerId],
    ['get', `player:${playerId}`],
    ['sismember', 'banned_players', playerId],
    ['sismember', 'shadow_banned_players', playerId],
    ['exists', `token:${playerId}`],
    ['llen', `save_hist:${playerId}`],
    ['lrange', `save_hist:${playerId}`, 0, 0],
    ['lrange', 'save_reject_log', 0, 299],
    ['lrange', 'save_heal_log', 0, 299],
    ['sismember', 'ranking_hidden_players', playerId],
  ]);
  const hidden = hidR.result === 1;
  let save = null; try { save = saveR.result ? JSON.parse(saveR.result) : null; } catch (e) {}
  let rank = null; try { rank = pR.result ? JSON.parse(pR.result) : null; } catch (e) {}
  let newestHist = null; try { newestHist = histR.result && histR.result[0] ? JSON.parse(histR.result[0]) : null; } catch (e) {}
  const mine = (arr) => (arr || []).map(x => { try { return JSON.parse(x); } catch (e) { return null; } })
                                    .filter(x => x && x.playerId === playerId).slice(0, 10);

  const saveScore = save ? Math.floor(Number(save.clickerScore) || 0) : null;
  const zScore = zR.result != null ? Math.floor(Number(zR.result)) : null;
  const shadow = shR.result === 1, banned = banR.result === 1;

  const findings = [];
  if (shadow) findings.push('シャドウBAN中：セーブは保存されるが、ランキングの更新は黙って捨てられる');
  if (banned) findings.push('BAN中：保存そのものが拒否される（403）');
  if (save && zScore != null && saveScore !== zScore) findings.push('ランキングの隻数とセーブの隻数が違う');
  if (hidden) findings.push('ランキング非表示に設定中（セーブは通常どおり）');
  if (save && zScore == null && !hidden) findings.push('ランキングに載っていない');
  if (!save) findings.push('セーブが存在しない');
  const tokenMis = mine(rejR.result).filter(x => String(x.reason).startsWith('token_mismatch'));
  if (tokenMis.length) findings.push('別端末からの保存がある（鍵違い ' + tokenMis.length + ' 件）');
  if (save && save.lastSaveTime && Date.now() - save.lastSaveTime > 3 * 86400000)
    findings.push('最終保存が3日以上前');

  return res.status(200).json({
    success: true, playerId, findings,
    save: save ? { clickerScore: saveScore, lastSaveTime: save.lastSaveTime,
                   reincarnationCount: save.reincarnationCount, superReincarnationCount: save.superReincarnationCount,
                   skillCount: countTrue(save.skills) + countTrue(save.superSkills),
                   facilityCount: countFacilities(save.facilities), playerName: save.playerName } : null,
    ranking: { zscore: zScore, record: rank },
    flags: { banned, shadowBanned: shadow, rankingHidden: hidden, hasToken: tokR.result === 1 },
    history: { count: hlR.result || 0,
               newest: newestHist ? { clickerScore: newestHist.clickerScore, lastSaveTime: newestHist.lastSaveTime } : null },
    recentRejects: mine(rejR.result),
    recentHeals: mine(healR.result),
  });
}

// ---- 全体の直近の拒否・修復記録 ----
async function recentLogs(res) {
  const [rej, heal] = await redisPipeline([
    ['lrange', 'save_reject_log', 0, 99],
    ['lrange', 'save_heal_log', 0, 49],
  ]);
  const parse = (a) => (a || []).map(x => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean);
  const rejects = parse(rej.result);
  const byReason = {};
  rejects.forEach(r => { byReason[r.reason] = (byReason[r.reason] || 0) + 1; });
  return res.status(200).json({ success: true, byReason, rejects: rejects.slice(0, 50), heals: parse(heal.result) });
}

// ---- ランキングを現在のセーブに合わせ直す ----
async function resyncRanking(playerId) {
  const r = await redisRequest(['get', `save:${playerId}`]);
  if (!r.result) return { ok: false, error: 'No save' };
  let s; try { s = JSON.parse(r.result); } catch (e) { return { ok: false, error: 'Corrupt save' }; }
  const score = rankScoreOf(s);
  const hid = await redisRequest(['sismember', 'ranking_hidden_players', playerId]);
  if (hid.result === 1) {
    await redisRequest(['zrem', 'ranking', playerId]);
    return { ok: true, clickerScore: score, hidden: true };
  }
  await redisPipeline([
    ['zadd', 'ranking', score, playerId],
    ['set', `player:${playerId}`, JSON.stringify({
      playerId,
      playerName: String(s.playerName || '名無しの船長').substring(0, 20),
      clickerScore: score,
      reincarnationCount: Number(s.reincarnationCount) || 0,
      fragments: Number(s.fragments) || 0,
      era: eraLabelOf(s),
      updatedAt: Date.now(),
    })],
  ]);
  return { ok: true, clickerScore: score };
}

// セーブの状態からランキングに出す時代名を決める
function eraLabelOf(save) {
  if (save.currentEra === 'jomon') return '縄文時代';
  if (save.superSkills && save.superSkills.meijiRestoration) return '明治時代';
  if (save.skills && save.skills.kaikoku) return '江戸時代（開国）';
  return '江戸時代（初期）';
}

// ランキングの値：シーズン2は「シーズン中に稼いだ合計」（これまでの周回＋今の周回）
function rankScoreOf(save) {
  if (save && save.pastLivesEarned != null) {
    return Math.floor((Number(save.pastLivesEarned) || 0) + (Number(save.currentLifeScore) || 0));
  }
  return Math.floor(Number(save && save.clickerScore) || 0);
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function countTrue(o) { return (o && typeof o === 'object') ? Object.values(o).filter(Boolean).length : 0; }
function countFacilities(f) {
  if (!f || typeof f !== 'object') return 0;
  return Object.values(f).reduce((s, x) => s + num(x && x.count), 0);
}
