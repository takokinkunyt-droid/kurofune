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
const GAMES = ['tap', 'oldmaid', 'oldmaid3', 'rta']; // 現在対応しているゲーム種別

// 対戦中チャットの設定
const CHAT_MAX_LEN = 100;
const CHAT_MAX_KEEP = 40;   // 保持する発言数
const CHAT_RATE_MS = 2000;  // 連投制限

// 黒船競い（rta）の設定
const RTA_DURATION_SEC = 300;  // 本番の長さ（5分）
const RTA_READY_TIMEOUT = 60000; // 準備完了を待つ上限（ミリ秒）。超えたら強制開始
// 3分間で理論上到達しうる上限。これを超える申告は不正とみなして切り捨てる。
const RTA_MAX_SCORE = 50000000;

// 賭け金は決められた「卓」の額のみを受け付ける。
// 自由な額を許すと待機列が分散してマッチしなくなるため。
const ALLOWED_BETS = [
  0,                  // ベータの間（賭け金なし・3人プレイ用）
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

// そのゲームに必要な人数
function requiredPlayers(game) {
  return game === 'oldmaid3' ? 3 : 2;
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


// ============================================
// ババ抜き（oldmaid）
// ============================================

// 52枚＋ジョーカー1枚の山を作る
function buildOldMaidDeck() {
  const deck = [];
  const suits = ['s', 'h', 'd', 'c'];
  for (const suit of suits) {
    for (let rank = 1; rank <= 13; rank++) {
      deck.push({ r: rank, s: suit });
    }
  }
  deck.push({ r: 0, s: 'joker' }); // r:0 がジョーカー
  // シャッフル
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// 手札から同じ数字のペアを取り除き、捨てた枚数を返す
function discardPairs(hand) {
  const counts = {};
  hand.forEach(c => { counts[c.r] = (counts[c.r] || 0) + 1; });
  let discarded = 0;
  for (const rank in counts) {
    if (rank === '0') continue; // ジョーカーは絶対にペアにならない
    const pairs = Math.floor(counts[rank] / 2);
    if (pairs > 0) {
      let toRemove = pairs * 2;
      for (let i = hand.length - 1; i >= 0 && toRemove > 0; i--) {
        if (String(hand[i].r) === rank) { hand.splice(i, 1); toRemove--; discarded++; }
      }
    }
  }
  return discarded;
}

// 対戦開始時に手札を配る（2人でも3人でも同じ手順）
function initOldMaid(match) {
  const deck = buildOldMaidDeck();
  const n = match.players.length;
  const hands = {};
  match.players.forEach(p => { hands[p.playerId] = []; });
  deck.forEach((card, i) => {
    hands[match.players[i % n].playerId].push(card);
  });
  Object.values(hands).forEach(h => discardPairs(h));
  match.hands = hands;
  // 最も手札が多い人から開始する
  let first = match.players[0];
  match.players.forEach(p => {
    if (hands[p.playerId].length > hands[first.playerId].length) first = p;
  });
  match.turn = first.playerId;
  match.finished = [];   // 上がった順に playerId が入る
  match.lastDraw = null;
  match.chat = [];
  match.state = 'playing';
  return match;
}

// まだ手札が残っている人（＝対戦継続中の人）の一覧
function activePlayers(match) {
  return match.players.filter(p => (match.hands[p.playerId] || []).length > 0);
}

// 時計回りで次に手番が回る人を返す（上がった人は飛ばす）
function nextTurnPlayer(match, currentId) {
  const order = match.players.map(p => p.playerId);
  const alive = activePlayers(match).map(p => p.playerId);
  if (alive.length === 0) return null;
  let idx = order.indexOf(currentId);
  for (let i = 1; i <= order.length; i++) {
    const cand = order[(idx + i) % order.length];
    if (alive.includes(cand)) return cand;
  }
  return alive[0];
}

// 手番の人から見て、時計回りで次にいる「引く相手」を返す
function drawTargetOf(match, playerId) {
  const order = match.players.map(p => p.playerId);
  const alive = activePlayers(match).map(p => p.playerId);
  let idx = order.indexOf(playerId);
  for (let i = 1; i <= order.length; i++) {
    const cand = order[(idx + i) % order.length];
    if (alive.includes(cand) && cand !== playerId) return cand;
  }
  return null;
}

// 自分から見た盤面。
// 対戦中の相手の手札は「枚数」しか返さない（中身が見えると不正になるため）。
// ただし上がった人＝観戦者には、残っている人の手札を公開する。
function oldMaidViewOf(match, playerId) {
  const me = match.players.find(p => p.playerId === playerId);
  if (!me) return null;
  const hands = match.hands || {};
  const myHand = hands[playerId] || [];
  const finished = match.finished || [];
  const iAmSpectator = finished.includes(playerId) && match.state !== 'done';
  const target = match.state === 'playing' ? drawTargetOf(match, match.turn) : null;

  const others = match.players.filter(p => p.playerId !== playerId).map(p => {
    const h = hands[p.playerId] || [];
    const showCards = iAmSpectator || match.state === 'done';
    return {
      playerId: p.playerId,
      name: p.name,
      count: h.length,
      cards: showCards ? h : null,      // 観戦中と決着後のみ中身を返す
      finished: finished.includes(p.playerId),
      rank: finished.indexOf(p.playerId) >= 0 ? finished.indexOf(p.playerId) + 1 : null,
      isTurn: match.turn === p.playerId,
      isDrawTarget: target === p.playerId && match.turn === playerId,
    };
  });

  return {
    matchId: match.matchId,
    state: match.state,
    bet: match.bet,
    game: match.game,
    playerCount: match.players.length,
    myHand,
    myName: me.name,
    myFinished: finished.includes(playerId),
    myRank: finished.indexOf(playerId) >= 0 ? finished.indexOf(playerId) + 1 : null,
    isSpectator: iAmSpectator,
    others,
    turn: match.turn,
    turnName: (match.players.find(p => p.playerId === match.turn) || {}).name || null,
    isMyTurn: match.turn === playerId && !finished.includes(playerId),
    drawTargetId: match.turn === playerId ? target : null,
    lastDraw: match.lastDraw,
    chat: match.chat || [],
    result: match.result || null,
    payout: computeOldMaidPayout(match, playerId),
  };
}

// 賭け金の配分：1位が80%、2位が20%、最下位は無し。
// 2人対戦のときは従来どおり勝者が総取り。
function computeOldMaidPayout(match, playerId) {
  if (!match.result) return 0;
  const finished = match.finished || [];
  if (match.players.length <= 2) {
    return match.result.winnerId === playerId ? match.pot : 0;
  }
  const rank = finished.indexOf(playerId);
  if (rank === 0) return Math.floor(match.pot * 0.8);
  if (rank === 1) return Math.floor(match.pot * 0.2);
  return 0;
}

// 勝敗が決したかを判定する
function checkOldMaidEnd(match) {
  match.finished = match.finished || [];
  // 新たに手札が0になった人を、上がった順に記録する
  match.players.forEach(p => {
    const h = match.hands[p.playerId] || [];
    if (h.length === 0 && !match.finished.includes(p.playerId)) {
      match.finished.push(p.playerId);
    }
  });

  const alive = activePlayers(match);
  // 残り1人になったら終了（その人がジョーカー持ち＝最下位）
  if (alive.length <= 1) {
    if (alive.length === 1 && !match.finished.includes(alive[0].playerId)) {
      match.finished.push(alive[0].playerId);
    }
    match.state = 'done';
    match.result = {
      winnerId: match.finished[0] || null,
      ranking: match.finished.slice(),
      draw: false,
      finishedAt: Date.now(),
    };
    return true;
  }
  return false;
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
      const rec = betAmount > 0 ? await redis(['get', `player:${playerId}`]) : { result: null };
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

      const need = requiredPlayers(game);

      if (opponentMatchId) {
        const match = await loadMatch(opponentMatchId);
        match.players.push({
          playerId,
          name: String(playerName || '名無しの船長').slice(0, 20),
          score: 0,
          submitted: false,
        });

        // まだ人数が足りなければ、待機のまま列に戻す
        if (match.players.length < need) {
          await saveMatch(match);
          await redis(['rpush', queueKey, match.matchId]);
          await redis(['expire', queueKey, WAIT_TTL]);
          return res.status(200).json({ status: 'waiting', matchId: match.matchId, joined: match.players.length, need });
        }

        // 人数が揃ったので対戦成立。この時点で全員の賭け金を場に預かる。
        match.state   = 'playing';
        match.pot     = match.bet * match.players.length;
        match.startAt = Date.now();
        if (match.game === 'oldmaid' || match.game === 'oldmaid3') {
          initOldMaid(match);
          await saveMatch(match);
          return res.status(200).json({ status: 'matched', ...oldMaidViewOf(match, playerId) });
        }
        if (match.game === 'rta') {
          match.state = 'ready';
          match.readyDeadline = Date.now() + RTA_READY_TIMEOUT;
          await saveMatch(match);
          return res.status(200).json({ status: 'matched', ...rtaViewOf(match, playerId) });
        }
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
      return res.status(200).json({ status: 'waiting', matchId, joined: 1, need });
    }

    // ── 対戦の状態を確認する ────────────────────────
    if (action === 'status') {
      const { matchId } = body;
      const match = await loadMatch(matchId);
      if (!match) return res.status(200).json({ status: 'expired' });

      // まだ人数が揃っていないときは、何人集まったかを返す
      if (match.state === 'waiting') {
        return res.status(200).json({
          status: 'waiting',
          matchId,
          joined: match.players.length,
          need: requiredPlayers(match.game),
        });
      }

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

      if (match.game === 'oldmaid' || match.game === 'oldmaid3') {
        const omView = oldMaidViewOf(match, playerId);
        if (!omView) return res.status(403).json({ error: 'この対戦の参加者ではありません' });
        return res.status(200).json({ status: match.state, ...omView });
      }

      if (match.game === 'rta') {
        // 準備完了の待ち合わせ。60秒を過ぎたら揃っていなくても開始する
        if (match.state === 'ready' && Date.now() > (match.readyDeadline || 0)) {
          match.state = 'playing';
          match.rtaStartAt = Date.now();
          await saveMatch(match);
        }
        const rView = rtaViewOf(match, playerId);
        if (!rView) return res.status(403).json({ error: 'この対戦の参加者ではありません' });
        return res.status(200).json({ status: match.state, ...rView });
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
        const cap = (match.game === 'rta') ? RTA_MAX_SCORE : TAP_MAX_SCORE;
        if (s > cap) s = cap;
        // 開始からの経過が短すぎる申告は無効（本番前に送る不正を防ぐ）
        if (match.game === 'rta' && match.rtaStartAt && Date.now() - match.rtaStartAt < (RTA_DURATION_SEC - 5) * 1000) {
          return res.status(400).json({ error: 'まだ勝負の途中です' });
        }
        me.score = s;
        me.submitted = true;
        me.submittedAt = Date.now();
      }

      const allSubmitted = match.players.length === 2 && match.players.every(p => p.submitted);
      if (allSubmitted && match.state !== 'done') resolveMatch(match);
      await saveMatch(match);

      if (match.game === 'rta') {
        return res.status(200).json({ status: match.state, ...rtaViewOf(match, playerId) });
      }
      return res.status(200).json({ status: match.state, ...viewOf(match, playerId) });
    }

    // ── 黒船競い：準備完了を伝える ──────────────────
    if (action === 'ready') {
      const { matchId } = body;
      const match = await loadMatch(matchId);
      if (!match) return res.status(200).json({ status: 'expired' });
      if (match.game !== 'rta') return res.status(400).json({ error: 'このゲームでは使えません' });

      const me = match.players.find(p => p.playerId === playerId);
      if (!me) return res.status(403).json({ error: 'この対戦の参加者ではありません' });
      me.ready = true;

      // 両者が押したら即開始する
      if (match.state === 'ready' && match.players.length === 2 && match.players.every(p => p.ready)) {
        match.state = 'playing';
        match.rtaStartAt = Date.now();
      }
      await saveMatch(match);
      return res.status(200).json({ status: match.state, ...rtaViewOf(match, playerId) });
    }

    // ── ババ抜き：相手の手札から1枚引く ──────────────
    if (action === 'draw') {
      const { matchId, index, targetId } = body;
      const match = await loadMatch(matchId);
      if (!match) return res.status(200).json({ status: 'expired' });
      if (match.game !== 'oldmaid' && match.game !== 'oldmaid3') return res.status(400).json({ error: 'このゲームでは使えません' });
      if (match.state !== 'playing') return res.status(200).json({ status: match.state, ...oldMaidViewOf(match, playerId) });

      const me = match.players.find(p => p.playerId === playerId);
      if (!me) return res.status(403).json({ error: 'この対戦の参加者ではありません' });

      // 手番でなければ引けない
      if (match.turn !== playerId) {
        return res.status(200).json({ status: match.state, ...oldMaidViewOf(match, playerId), error: 'まだあなたの番ではありません' });
      }

      // 引く相手はサーバーが決める（時計回りの次の人）
      const expected = drawTargetOf(match, playerId);
      if (!expected) return res.status(200).json({ status: match.state, ...oldMaidViewOf(match, playerId) });
      if (targetId && targetId !== expected) {
        return res.status(200).json({ status: match.state, ...oldMaidViewOf(match, playerId), error: 'その相手からは引けません' });
      }

      const oppHand = match.hands[expected];
      const i = Math.floor(Number(index));
      if (!(i >= 0 && i < oppHand.length)) {
        return res.status(400).json({ error: '引く位置が不正です' });
      }

      const drawn = oppHand.splice(i, 1)[0];
      const myHand = match.hands[playerId];
      myHand.push(drawn);
      const discarded = discardPairs(myHand);

      match.lastDraw = { by: playerId, from: expected, card: drawn, paired: discarded > 0, at: Date.now() };

      if (!checkOldMaidEnd(match)) {
        match.turn = nextTurnPlayer(match, playerId);
      }
      await saveMatch(match);
      return res.status(200).json({ status: match.state, ...oldMaidViewOf(match, playerId) });
    }

    // ── 対戦中チャット ─────────────────────────────
    if (action === 'chat') {
      const { matchId, text } = body;
      const match = await loadMatch(matchId);
      if (!match) return res.status(200).json({ status: 'expired' });

      const me = match.players.find(p => p.playerId === playerId);
      if (!me) return res.status(403).json({ error: 'この対戦の参加者ではありません' });

      // 上がった人（観戦者）は発言できない。手札が見えているため。
      const finished = match.finished || [];
      if (finished.includes(playerId) && match.state !== 'done') {
        return res.status(200).json({ status: match.state, ...oldMaidViewOf(match, playerId), error: '観戦中は発言できません' });
      }

      const msg = String(text || '').trim().slice(0, CHAT_MAX_LEN);
      if (!msg) return res.status(400).json({ error: 'メッセージが空です' });

      // 連投制限
      const rateKey = `match_chat_rate:${playerId}`;
      const rate = await redis(['exists', rateKey]);
      if (rate.result === 1) {
        return res.status(200).json({ status: match.state, ...oldMaidViewOf(match, playerId), error: '少し待ってから送信してください' });
      }
      await redis(['setex', rateKey, Math.ceil(CHAT_RATE_MS / 1000), '1']);

      match.chat = match.chat || [];
      match.chat.push({ playerId, name: me.name, text: msg, at: Date.now() });
      if (match.chat.length > CHAT_MAX_KEEP) match.chat = match.chat.slice(-CHAT_MAX_KEEP);
      await saveMatch(match);
      return res.status(200).json({ status: match.state, ...oldMaidViewOf(match, playerId) });
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
