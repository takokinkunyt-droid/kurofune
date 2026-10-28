const { redisRequest, redisPipeline, parseBody, CORS } = require('./_redis');
const LV = require('./_level');

// =====================================================================
// セーブの書き込み口。
//
// セーブ消失を踏まえて4つの層を足した。
//
//  1) 履歴バックアップ（無条件）
//     上書きの前に、必ず直前の状態を save_hist:<id> へ積む（最大20世代）。
//     原因が何であれ、消えたら restore-save.js で数秒で戻せる。これが本命。
//
//  2) 巻き戻しガード
//     直前の保存より極端に後退したデータを拒否する。
//     転生のように正当に減る場合はクライアントが allowShrink を立てて通す。
//
//  3) 中身抜けガード
//     施設と実績だけ残ってスキル・転生回数が全滅、という壊れ方を止める。
//
//  4) セーブトークン照合（REQUIRE_SAVE_TOKEN=1 のときだけ必須化）
//     この API は無認証で、playerId は get-ranking から読めてしまう。
//     既存プレイヤーを弾く事故を避けるため、既定は
//     「トークンがあれば照合、無ければ通す」。全員が一度ゲームを
//     開いたのを確認してから 1 にする。
// =====================================================================

const HISTORY_MAX = 20;
const REQUIRE_TOKEN = process.env.REQUIRE_SAVE_TOKEN === '1';

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const { playerId, saveData, saveToken, seasonReset } = await parseBody(req);
    if (!playerId || !saveData) return res.status(400).json({ error: 'Missing playerId or saveData' });
    if (typeof playerId !== 'string' || playerId.length > 64) {
      return res.status(400).json({ error: 'Bad playerId' });
    }
    // 施設が無いセーブは壊れている。どんな事情でも書かせない。
    if (typeof saveData !== 'object' || !saveData.facilities) {
      return res.status(400).json({ error: 'Incomplete saveData', code: 'NO_FACILITIES' });
    }

    // ─── BAN チェック ──────────────────────────────────
    const banCheck = await redisRequest(['sismember', 'banned_players', playerId]);
    if (banCheck.result === 1) {
      console.warn(`[save-game] BANされたプレイヤーの保存試行: ${playerId}`);
      return res.status(403).json({ error: 'アカウントが停止されています', banned: true });
    }

    // ─── 4) トークン照合 ───────────────────────────────
    if (!(await checkToken(playerId, saveToken))) {
      await logReject(playerId, 'token_mismatch', {});
      return res.status(403).json({ error: 'Save token mismatch', code: 'TOKEN_MISMATCH' });
    }

    // ─── 直前の状態 ────────────────────────────────────
    const prevRaw = await redisRequest(['get', `save:${playerId}`]);
    let prev = null;
    if (prevRaw.result) {
      try { prev = JSON.parse(prevRaw.result); } catch (e) { prev = null; }
    }

    // ─── 2) 3) ガード ──────────────────────────────────
    // 隻数が減ること自体は正常（買い物・賭け・転生）。割合では判定しない。
    // 守るのは「初期状態での上書き」だけ。
    // 初期状態での上書きを許すのはシーズン切り替えのときだけ。
    // 転生や賭けの allowShrink では通さない（それらは初期状態にならない）。
    if (prev && !seasonReset) {
      const gutted = findGutted(prev, saveData);
      if (gutted) {
        await logReject(playerId, 'gutted:' + gutted, {});
        return res.status(409).json({
          error: 'Incomplete save rejected', code: 'GUTTED_REJECTED', detail: gutted,
        });
      }
    }

    // ─── 1) 履歴へ積んでから保存 ───────────────────────
    const dataToSave = { ...saveData, playerId, lastSaveTime: Date.now() };
    const commands = [];
    if (prevRaw.result) {
      commands.push(['lpush', `save_hist:${playerId}`, prevRaw.result]);
      commands.push(['ltrim', `save_hist:${playerId}`, 0, HISTORY_MAX - 1]);
    }
    commands.push(['set', `save:${playerId}`, JSON.stringify(dataToSave)]);
    await redisPipeline(commands);

    // レベル（EXP）を数え直して、レベルのランキングへ。失敗しても保存は成功扱い。
    let lv = null;
    try { lv = await updateLevel(playerId, dataToSave); } catch (e) { console.error('[save-game] level', e.message); }

    return res.status(200).json({ success: true, timestamp: dataToSave.lastSaveTime, ...(lv || {}) });

  } catch (e) {
    console.error('[save-game]', e);
    return res.status(500).json({ error: e.message });
  }
};

// レベル：セーブの記録から数えた EXP ＋ 加入プランの毎月の EXP。
// 加入プランの分は「その月に加入していた」ことを月ごとに記録しておき、合計する（同じ月は1回だけ）。
async function updateLevel(playerId, save) {
  const subKey = LV.SUBEXP_PREFIX + playerId;
  const [shadow, hidden, subRaw, subExpRaw] = await redisPipeline([
    ['sismember', 'shadow_banned_players', playerId],
    ['sismember', 'ranking_hidden_players', playerId],
    ['get', `sub:${playerId}`],
    ['hgetall', subKey],
  ]);
  const months = {};
  const arr = (subExpRaw && subExpRaw.result) || [];
  for (let i = 0; i + 1 < arr.length; i += 2) months[arr[i]] = Number(arr[i + 1]) || 0;

  let sub = null; try { sub = JSON.parse(subRaw && subRaw.result); } catch (e) {}
  const cmds = [];
  if (sub && sub.until > Date.now() && LV.PLAN_MONTHLY_EXP[sub.plan]) {
    const m = LV.jstMonth(), amount = LV.PLAN_MONTHLY_EXP[sub.plan];
    if ((months[m] || 0) < amount) { months[m] = amount; cmds.push(['hset', subKey, m, amount]); }
  }
  const subExp = Object.values(months).reduce((a, b) => a + b, 0);
  const exp = LV.expFromSave(save) + subExp;
  if (shadow.result !== 1 && hidden.result !== 1) cmds.push(['zadd', LV.LEVEL_KEY, exp, playerId]);
  else cmds.push(['zrem', LV.LEVEL_KEY, playerId]);
  if (cmds.length) await redisPipeline(cmds);
  return { exp, subExp, level: LV.levelFromExp(exp).level };
}

// トークンがあれば固定・照合する。無い場合は REQUIRE_TOKEN 次第。
async function checkToken(playerId, saveToken) {
  const valid = typeof saveToken === 'string' && saveToken.length >= 16 && saveToken.length <= 128;
  const key = `token:${playerId}`;
  const stored = await redisRequest(['get', key]);

  if (stored.result) {
    if (!valid) return !REQUIRE_TOKEN;      // 古いクライアントは移行中だけ通す
    if (stored.result === saveToken) return true;
    // 鍵が違う＝別の端末から遊んでいる可能性が高い（学校のPCと家のスマホなど）。
    // 鍵は端末ごとに作られるので、必須にすると2台目から一切保存できなくなる。
    // REQUIRE_SAVE_TOKEN=1 のときだけ拒否し、それ以外は記録だけ残して通す。
    // 中身を壊す上書きは findGutted と履歴・自動修復で別に守っている。
    if (REQUIRE_TOKEN) return false;
    await logReject(playerId, 'token_mismatch_allowed', {});
    return true;
  }
  if (valid) {
    const claim = await redisRequest(['set', key, saveToken, 'NX']);
    if (!claim.result) {
      const again = await redisRequest(['get', key]);
      return again.result === saveToken;
    }
    return true;
  }
  return !REQUIRE_TOKEN;
}

// 「前は持っていたのに今回のデータでは丸ごと無い」状態を探す。
// 昇天スキル・転生回数・かけらは、本当の転生（＝縄文時代へ）以外では
// 0 に戻らない。戻っていたら壊れたデータとみなす。
// 守りたいのは「ゲームが初期状態で起動して、正しいデータを上書きする」事故。
// 以前は「値が大きく減ったら拒否」にしていたが、これは誤爆する。
//   ・かけらを使い切って昇天アップグレードを買う
//   ・高額な施設を買って隻数が1%未満になる
// どちらも正常なプレイなのに保存が止まり、ランキングも更新されなくなっていた。
//
// そこで「初期状態そのもの」だけを見る。
// 施設0・スキル0・転生0が同時に成立するのは、起動直後か
// 本当の転生（縄文行き）か、シーズンの切り替えだけ。
// 何かを買っただけなら施設もスキルも残るので、絶対に誤爆しない。
// 守るのは「中身のあるセーブが、壊れた状態で上書きされる」事故。
//
// 止める条件は、通常のプレイでは絶対に起きないものだけにする。
//   ・初期状態（施設0・スキル0・転生0）での上書き
//   ・昇天／超昇天スキルが全部消える     … 消えるのは本当の転生かシーズン切り替えだけ
//   ・転生回数・超転生回数が 0 に戻る     … 同上
//
// 以前あった「かけらが0」「隻数が1%未満」は誤爆していた
// （かけらを使い切る・高額な施設を買う、で普通に起きる）ので入れない。
//
// 2026-10-06 の消失、10-09 に記録された player_mtptjbv7 の件は、
// どちらも「施設は残ってスキルと転生回数だけ消える」形だった。
// 初期状態の判定だけではこれを止められない。
function findGutted(prev, next) {
  if (next.currentEra === 'jomon') return null;        // 本当の転生は正常

  // シーズン2のスキルの木（s2tree）も「積み上げ」として数える
  const prevSkill = countTrue(prev.skills) + countTrue(prev.superSkills) + countTrue(prev.s2tree);
  const nextSkill = countTrue(next.skills) + countTrue(next.superSkills) + countTrue(next.s2tree);
  if (prevSkill > 0 && nextSkill === 0) return 'skills';

  const prevReinc = num(prev.reincarnationCount) + num(prev.superReincarnationCount);
  const nextReinc = num(next.reincarnationCount) + num(next.superReincarnationCount);
  if (prevReinc > 0 && nextReinc === 0) return 'reincarnation';

  const nextIsBlank = countFacilities(next.facilities) === 0 && nextSkill === 0 && nextReinc === 0;
  const prevHad = countFacilities(prev.facilities) > 0 || prevSkill > 0 || prevReinc > 0;
  if (nextIsBlank && prevHad) return 'blank_overwrite';

  return null;
}

async function logReject(playerId, reason, extra) {
  try {
    await redisRequest(['lpush', 'save_reject_log',
      JSON.stringify({ playerId, at: Date.now(), reason, ...extra })]);
    await redisRequest(['ltrim', 'save_reject_log', 0, 299]);
  } catch (e) { /* ログ失敗で本処理は止めない */ }
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function countTrue(o) { return (o && typeof o === 'object') ? Object.values(o).filter(Boolean).length : 0; }
function countFacilities(f) {
  if (!f || typeof f !== 'object') return 0;
  return Object.values(f).reduce((s, x) => s + num(x && x.count), 0);
}
