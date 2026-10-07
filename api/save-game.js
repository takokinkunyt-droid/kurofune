const { redisRequest, redisPipeline, parseBody, CORS } = require('./_redis');

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
    const { playerId, saveData, saveToken, allowShrink } = await parseBody(req);
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
    const nextScore = Number(saveData.clickerScore) || 0;
    if (prev && !allowShrink) {
      const prevScore = Number(prev.clickerScore) || 0;
      if (prevScore > 1000 && nextScore < prevScore * 0.01) {
        await logReject(playerId, 'shrink', { prevScore, nextScore });
        return res.status(409).json({
          error: 'Suspicious rollback rejected', code: 'ROLLBACK_REJECTED', prevScore, nextScore,
        });
      }
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

    return res.status(200).json({ success: true, timestamp: dataToSave.lastSaveTime });

  } catch (e) {
    console.error('[save-game]', e);
    return res.status(500).json({ error: e.message });
  }
};

// トークンがあれば固定・照合する。無い場合は REQUIRE_TOKEN 次第。
async function checkToken(playerId, saveToken) {
  const valid = typeof saveToken === 'string' && saveToken.length >= 16 && saveToken.length <= 128;
  const key = `token:${playerId}`;
  const stored = await redisRequest(['get', key]);

  if (stored.result) {
    if (!valid) return !REQUIRE_TOKEN;      // 古いクライアントは移行中だけ通す
    return stored.result === saveToken;
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
function findGutted(prev, next) {
  if (next.currentEra === 'jomon') return null;   // 本当の転生は全部消えて正常
  const hadSkill = countTrue(prev.skills) + countTrue(prev.superSkills);
  const hasSkill = countTrue(next.skills) + countTrue(next.superSkills);
  if (hadSkill > 0 && hasSkill === 0) return 'skills';

  const hadReinc = num(prev.reincarnationCount) + num(prev.superReincarnationCount);
  const hasReinc = num(next.reincarnationCount) + num(next.superReincarnationCount);
  if (hadReinc > 0 && hasReinc === 0) return 'reincarnation';

  const hadFrag = num(prev.fragments) + num(prev.sakokuShards);
  const hasFrag = num(next.fragments) + num(next.sakokuShards);
  if (hadFrag > 10 && hasFrag === 0) return 'fragments';

  const hadFac = countFacilities(prev.facilities);
  const hasFac = countFacilities(next.facilities);
  if (hadFac > 50 && hasFac === 0 && hasReinc <= hadReinc) return 'facilities';

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
