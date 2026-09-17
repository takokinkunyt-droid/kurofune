/**
 * /api/match
 *
 * 浦賀賭博室のオンライン対戦（連打競い）用API。
 *
 * POST body: { action, ... }
 *   action: 'join'    { playerId, playerName, game, bet } → 対戦相手を探す／待機列に入る
 *   action: 'status'  { matchId, playerId }               → 対戦の現在の状態を取得
 *   action: 'submit'  { matchId, playerId, score, taps }  → 自分のスコアを提出
 *   action: 'cancel'  { matchId, playerId }               → 待機中の対戦を取り消す
 *
 * 賭け金は「join の時点で両者から預かる」方式。
 * 途中でブラウザを閉じられても、場に預かった分から勝者へ支払えるようにしている。
 */
const https = require('https');

const MATCH_TTL      = 600;   // 対戦データの保持時間（秒）
const WAIT_TTL       = 120;   // 待機列に並んでいられる時間（秒）
const SUBMIT_TIMEOUT = 45000; // 相手のスコア提出を待つ上限（ミリ秒）
const GAMES = ['tap'];        // 現在対応しているゲーム種別

// 賭け金は決められた「卓」の額のみを受け付ける。
// 自由な額を許すと待機列が分散してマッチしなくなるため。
const ALLOWED_BETS = [
  10000,              // 小判の間
  1000000,            // 千両の間
  100000000,          // 大判の間
  1000000000000,      // 黒船の間
  10000000000000000,  // ペリーの間
];

// 連打競いで人間が出しうる上限。これを超える申告は不正とみなす。
const TAP_DURATION_SEC = 10;
const TAP_MAX_PER_SEC  = 25;
const TAP_MAX_SCORE    = TAP_DURATION_SEC * TAP_MAX_PER_SEC;

function redis(command) {
  return new Promise((resolve, reject) => {
    const url   = new URL(process.env.UPSTASH_REDIS_REST_URL);
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    const data  = JSON.stringify(command);
    const req = https.request({
      hostname: url.hostname, port: 443,
      path: url.pathname + (url.search || ''),
      method: 'POST',
      headers: {
        'Authorization':  `Bearer ${token}`,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (r) => {
      let body = '';
      r.on('data', c => { body += c; });
      r.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

async function loadMatch(matchId) {
  const r = await redis(['get', `match:${matchId}`]);
  if (!r.result) return null;
  try { return JSON.parse(r.result); } catch (e) { return null; }
}

async function saveMatch(match) {
  await redis(['setex', `match:${match.matchId}`, MATCH_TTL, JSON.stringify(match)]);
}

// 対戦相手から見た自分／相手を整理して返す
function viewOf(match, playerId) {
  const me       = match.players.find(p => p.playerId === playerId);
  const opponent = match.players.find(p => p.playerId !== playerId);
  if (!me) return null;
  return {
    matchId:  match.matchId,
    state:    match.state,
    bet:      match.bet,
    game:     match.game,
    startAt:  match.startAt || null,
    me:       { name: me.name, score: me.score, submitted: me.submitted },
    opponent: opponent ? { name: opponent.name, score: match.state === 'done' ? opponent.score : null, submitted: opponent.submitted } : null,
    result:   match.result || null,
    payout:   (match.result && match.result.winnerId === playerId) ? match.pot : 0,
  };
}

// 両者のスコアが揃ったら勝敗を確定させる
function resolveMatch(match) {
  const [a, b] = match.players;
  let winnerId = null;
  if (a.score > b.score)      winnerId = a.playerId;
  else if (b.score > a.score) winnerId = b.playerId;
  // 同点は引き分け（winnerId は null のまま）

  match.state  = 'done';
  match.result = {
    winnerId,
    draw: winnerId === null,
    scores: { [a.playerId]: a.score, [b.playerId]: b.score },
    finishedAt: Date.now(),
  };
  return match;
}

module.exports = async (req, res) => {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const body = await readBody(req);
    const { action, playerId } = body;
    if (!playerId) return res.status(400).json({ error: 'playerId が必要です' });

    // BANされている人は対戦に参加できない
    const banned = await redis(['sismember', 'shadow_banned_players', playerId]);
    if (banned.result === 1) {
      // 相手に気づかれないよう、いつまでも相手が見つからない状態にする
      return res.status(200).json({ status: 'waiting', matchId: 'pending_' + genId() });
    }

    // ── 対戦相手を探す ─────────────────────────────
    if (action === 'join') {
      const { playerName, game, bet } = body;
      if (!GAMES.includes(game)) return res.status(400).json({ error: '対応していないゲームです' });

      const betAmount = Math.floor(Number(bet) || 0);
      if (!ALLOWED_BETS.includes(betAmount)) {
        return res.status(400).json({ error: '用意されていない卓です' });
      }

      // 申告された賭け金が、記録されている保有数を超えていないか確認する
      const rec = await redis(['get', `player:${playerId}`]);
      if (rec.result) {
        try {
          const known = JSON.parse(rec.result);
          if (typeof known.clickerScore === 'number' && betAmount > known.clickerScore * 1.05) {
            return res.status(400).json({ error: '賭け金が保有数を超えています' });
          }
        } catch (e) { /* 記録が壊れている場合は素通しする */ }
      }

      const queueKey = `match_queue:${game}:${betAmount}`;

      // 待機列から相手を取り出す（自分自身は除く）
      let opponentMatchId = null;
      for (let i = 0; i < 5; i++) {
        const popped = await redis(['lpop', queueKey]);
        if (!popped.result) break;
        const candidate = await loadMatch(popped.result);
        if (!candidate || candidate.state !== 'waiting') continue;
        if (candidate.players[0].playerId === playerId) continue; // 自分とはマッチさせない
        opponentMatchId = popped.result;
        break;
      }

      if (opponentMatchId) {
        // 相手が見つかったので対戦成立。この時点で両者の賭け金を場に預かる。
        const match = await loadMatch(opponentMatchId);
        match.players.push({
          playerId,
          name: String(playerName || '名無しの船長').slice(0, 20),
          score: 0,
          submitted: false,
        });
        match.state   = 'playing';
        match.pot     = match.bet * 2;
        match.startAt = Date.now();
        await saveMatch(match);
        return res.status(200).json({ status: 'matched', ...viewOf(match, playerId) });
      }

      // 相手がいないので、自分が待機側として列に並ぶ
      const matchId = genId();
      const match = {
        matchId,
        game,
        bet: betAmount,
        pot: betAmount, // 相手が来たら2倍になる
        state: 'waiting',
        createdAt: Date.now(),
        players: [{
          playerId,
          name: String(playerName || '名無しの船長').slice(0, 20),
          score: 0,
          submitted: false,
        }],
      };
      await saveMatch(match);
      await redis(['rpush', queueKey, matchId]);
      await redis(['expire', queueKey, WAIT_TTL]);
      return res.status(200).json({ status: 'waiting', matchId });
    }

    // ── 対戦の状態を確認する ────────────────────────
    if (action === 'status') {
      const { matchId } = body;
      const match = await loadMatch(matchId);
      if (!match) return res.status(200).json({ status: 'expired' });

      // 相手がスコアを出さないまま時間切れになったら、提出済みの側の不戦勝にする
      if (match.state === 'playing' && match.players.length === 2) {
        const submittedPlayer = match.players.find(p => p.submitted);
        if (submittedPlayer && Date.now() - (submittedPlayer.submittedAt || 0) > SUBMIT_TIMEOUT) {
          const other = match.players.find(p => p.playerId !== submittedPlayer.playerId);
          other.score = 0;
          other.submitted = true;
          resolveMatch(match);
          match.result.timeout = true;
          await saveMatch(match);
        }
      }

      const view = viewOf(match, playerId);
      if (!view) return res.status(403).json({ error: 'この対戦の参加者ではありません' });
      return res.status(200).json({ status: match.state, ...view });
    }

    // ── スコアを提出する ───────────────────────────
    if (action === 'submit') {
      const { matchId, score } = body;
      const match = await loadMatch(matchId);
      if (!match) return res.status(200).json({ status: 'expired' });

      const me = match.players.find(p => p.playerId === playerId);
      if (!me) return res.status(403).json({ error: 'この対戦の参加者ではありません' });

      if (!me.submitted) {
        // 人間には出せない値は切り捨てる
        let s = Math.floor(Number(score) || 0);
        if (s < 0) s = 0;
        if (s > TAP_MAX_SCORE) s = TAP_MAX_SCORE;
        me.score = s;
        me.submitted = true;
        me.submittedAt = Date.now();
      }

      const allSubmitted = match.players.length === 2 && match.players.every(p => p.submitted);
      if (allSubmitted && match.state !== 'done') resolveMatch(match);
      await saveMatch(match);

      return res.status(200).json({ status: match.state, ...viewOf(match, playerId) });
    }

    // ── 待機を取り消す ─────────────────────────────
    if (action === 'cancel') {
      const { matchId } = body;
      const match = await loadMatch(matchId);
      if (!match) return res.status(200).json({ status: 'expired', refunded: true });

      // まだ相手が来ていなければ取り消せる（賭け金は返る）
      if (match.state === 'waiting') {
        await redis(['del', `match:${matchId}`]);
        await redis(['lrem', `match_queue:${match.game}:${match.bet}`, 0, matchId]);
        return res.status(200).json({ status: 'cancelled', refunded: true });
      }
      // 既に対戦が始まっている場合は取り消せない
      return res.status(200).json({ status: match.state, refunded: false, ...viewOf(match, playerId) });
    }

    return res.status(400).json({ error: 'action は join / status / submit / cancel のいずれかです' });
  } catch (error) {
    console.error('[match]', error.message);
    return res.status(500).json({ error: error.message });
  }
};
