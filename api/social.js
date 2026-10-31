const { redisRequest, redisPipeline, parseBody, CORS } = require('./_redis');
const LV = require('./_level');
const SS = require('./_substyle');

// =====================================================================
// ソーシャル：フレンド・DM・黒船談話室S2
//
// すべて POST { playerId, saveToken, action, ... }。
// 本人確認はセーブと同じ鍵（token:<id>）。鍵が違う端末からは使えない
// （なりすましで他人の名前で話されるのを防ぐため）。
//
// 相手の指定は playerId ではなく「フレンドコード」で行う。playerId は外に出さない。
//
//  me                         … 自分のコード・フレンド・申請・ブロック・未読をまとめて返す
//  poll                       … 未読DMと届いた申請の数だけ（バッジ用・軽い）
//  request   { code }         … フレンド申請（相手からも申請が来ていれば、その場でフレンド）
//  respond   { code, accept } … 届いた申請に答える
//  cancel    { code }         … 送った申請を取り消す
//  unfriend  { code }         … フレンドをやめる
//  block     { code }         … ブロック（フレンド・申請も消え、DMも届かない。談話室でも見えなくなる）
//  unblock   { code }
//  dm_get    { code }         … その人とのDM（新しい100件）。開いたら既読
//  dm_send   { code, text }   … DM を送る（フレンドだけ）
//  lounge_get { since }       … 談話室の発言（新しい100件、since より新しいものだけ）
//  lounge_send { text }
//  report    { kind:'dm'|'lounge', code, msgId, reason } … 通報
//
// 管理（secret が必要）
//  admin_reports              … 通報の一覧
//  admin_dm   { reportAt }    … 通報された会話だけ読める（通報されていない会話は読めない）
//  admin_lounge_delete { msgId }
//  admin_img_delete { imgId }  … 画像を消す（通報された画像など）
//
// 画像（超魁プランだけ。DM・談話室）
//  dm_send / lounge_send に image（端末で縮めたJPEGの data URL）を付けると、画像つきで送れる。
//  端末側で縮めて描き直すので、写真の位置情報（GPS）などは残らない。サーバーでも形式と大きさを確かめる。
//  画像は30日で消える。1人1日20枚まで。見るときは GET ?img=<id>
//  admin_mute / admin_unmute { playerId } … 話す機能（DM・談話室・申請）だけ止める。ゲームとセーブはそのまま
//
// 目安箱（開発者にだけ届く。ほかのプレイヤーには見えない）
//  idea_send { kind:'want'|'fix'|'other', text } … 1通500文字まで。1分に1通、1日5通まで
//  idea_mine                  … 自分が送ったもの（読んだ・やった！などの状態と、開発者からの返事つき）
//  admin_ideas { open }       … 届いたものの一覧（open: true なら、やった／見送り を除く）
//  admin_idea_set { id, status, reply } … 状態と返事を付ける。返事は送った本人にだけ見える
//  admin_idea_delete { id }
//
// 安全のための決まり
//  ・DM はフレンドどうしだけ。ブロックした／された相手には届かない
//  ・1通200文字まで。10秒に3通まで
//  ・電話番号・メールアドレス・URL・ひどい言葉は＊に置き換える
//  ・DM は会話ごとに新しい200件、談話室は300件だけ残す
//  ・シャドウBANの人の発言は、本人にだけ見える
// =====================================================================

const ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_LEN = 200;
const DM_KEEP = 200;
const LOUNGE_KEEP = 300;
const MAX_FRIENDS = 100;
const MAX_OUT_REQ = 30;
const ONLINE_MS = 3 * 60 * 1000;

const NG_WORDS = ['死ね', 'しね', 'シネ', '氏ね', '殺す', 'ころす', 'コロス', '消えろ', 'きえろ', 'ガイジ', 'がいじ',
  'きちがい', 'キチガイ', 'セックス', 'せっくす', 'ちんこ', 'チンコ', 'まんこ', 'マンコ', 'ちんちん', 'おっぱい',
  'エロ', 'えろ', 'ヌード', 'ぬーど', 'sex', 'fuck', 'shit', 'porn'];

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'GET' && req.query && req.query.img) return serveImage(String(req.query.img), res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const body = await parseBody(req);
    const action = String(body.action || '');

    if (action.startsWith('admin_')) return admin(body, res);

    const me = body.playerId;
    if (!me || typeof me !== 'string' || me.length > 64) return res.status(400).json({ error: 'Bad playerId' });

    // 新しい発言があるかの確認は、5秒おきに来る。データベースの回数を節約するため、
    // 「最後の発言の時刻」だけを見て、増えていなければ本人確認もせずに「変わりなし」と返す。
    // 浦賀沖大砲戦の対戦中のやりとり（1秒に1回）。本人確認の代わりに、対戦ごとの秘密の鍵で書き込む
    if (action === 'cbt_sync') return res.status(200).json(await cbSync(body));

    if (action === 'lounge_get' && Number(body.since) > 0) {
      const last = Number((await redisRequest(['get', 'lounge:s2:last'])).result) || 0;
      if (last <= Number(body.since)) return res.status(200).json({ success: true, messages: [], unchanged: true });
    }
    if (action === 'dm_get' && Number(body.since) > 0) {
      const other = await idOfCode(body.code);
      if (other) {
        const last = Number((await redisRequest(['get', 'dml:' + convoKey(me, other)])).result) || 0;
        if (last <= Number(body.since)) return res.status(200).json({ success: true, messages: [], unchanged: true });
      }
    }

    const auth = await checkAuth(me, body.saveToken);
    if (auth === 'banned') return res.status(403).json({ error: 'アカウントが停止されています', code: 'BANNED' });
    if (auth !== 'ok') return res.status(403).json({ error: 'この端末からは使えません。最初に遊んだ端末で開いてください。', code: 'TOKEN' });

    const myName = cleanName(body.playerName);
    let shadow = false;
    if (['dm_send', 'lounge_send', 'request'].includes(action)) {
      const [muted, sb] = await redisPipeline([['sismember', 'social_muted', me], ['sismember', 'shadow_banned_players', me]]);
      if (muted.result === 1) return res.status(200).json({ success: false, error: '管理人により、話す機能が止められています' });
      shadow = sb.result === 1;
    }
    if (action === 'me' || action === 'poll' || action.startsWith('cbt_')) {
      // 最後に見かけた時刻（フレンドの一覧の「オンライン」用）と、名前の控え
      await redisPipeline([['set', `seen:${me}`, Date.now(), 'EX', 30 * 86400], ['set', `sname:${me}`, myName, 'EX', 120 * 86400]]);
    }

    switch (action) {
      case 'me':          return res.status(200).json({ success: true, ...(await meView(me)) });
      case 'poll':        return res.status(200).json({ success: true, ...(await pollView(me)) });
      case 'request':     return res.status(200).json(await doRequest(me, body.code, shadow));
      case 'respond':     return res.status(200).json(await doRespond(me, body.code, !!body.accept));
      case 'cancel':      return res.status(200).json(await doCancel(me, body.code));
      case 'unfriend':    return res.status(200).json(await doUnfriend(me, body.code));
      case 'block':       return res.status(200).json(await doBlock(me, body.code));
      case 'unblock':     return res.status(200).json(await doUnblock(me, body.code));
      case 'dm_get':      return res.status(200).json(await dmGet(me, body.code));
      case 'dm_send':     return res.status(200).json(await dmSend(me, myName, body.code, body.text, shadow, body.image));
      case 'lounge_get':  return res.status(200).json(await loungeGet(me, Number(body.since) || 0));
      case 'lounge_send': return res.status(200).json(await loungeSend(me, myName, body.text, shadow, body.image));
      case 'report':      return res.status(200).json(await doReport(me, body));
      case 'idea_send':   return res.status(200).json(await ideaSend(me, myName, body.kind, body.text));
      case 'idea_mine':   return res.status(200).json(await ideaMine(me));
      case 'cbt_find':    return res.status(200).json(await cbFind(me, body.ticket));
      case 'cbt_cancel':  return res.status(200).json(await cbCancel(me, body));
      case 'cbt_invite':  return res.status(200).json(await cbInvite(me, myName, body.code));
      case 'cbt_invite_poll': return res.status(200).json(await cbInvitePoll(me, body.inviteId));
      case 'cbt_incoming': return res.status(200).json({ success: true, invite: await cbIncoming(me) });
      case 'cbt_answer':  return res.status(200).json(await cbAnswer(me, body.inviteId, !!body.accept));
      default:            return res.status(400).json({ error: 'Unknown action' });
    }
  } catch (e) {
    console.error('[social]', e);
    return res.status(500).json({ error: e.message });
  }
};

// ---------------------------------------------------------------- 本人確認
async function checkAuth(playerId, saveToken) {
  const valid = typeof saveToken === 'string' && saveToken.length >= 16 && saveToken.length <= 128;
  if (!valid) return 'token';
  const [ban, stored] = await redisPipeline([['sismember', 'banned_players', playerId], ['get', `token:${playerId}`]]);
  if (ban.result === 1) return 'banned';
  if (!stored.result) {
    // まだ鍵が無い人は、この端末の鍵で固定する（セーブと同じ）
    const claim = await redisRequest(['set', `token:${playerId}`, saveToken, 'NX']);
    if (claim.result) return 'ok';
    const again = await redisRequest(['get', `token:${playerId}`]);
    return again.result === saveToken ? 'ok' : 'token';
  }
  return stored.result === saveToken ? 'ok' : 'token';
}

// ---------------------------------------------------------------- フレンドコード
function normCode(c) { return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^KF/, '').slice(0, 6); }
function showCode(c) { return 'KF-' + c; }

async function codeOf(id) {
  const r = await redisRequest(['get', `fcode_of:${id}`]);
  if (r.result) return r.result;
  for (let tries = 0; tries < 8; tries++) {
    let c = '';
    for (let i = 0; i < 6; i++) c += ALPH[Math.floor(Math.random() * ALPH.length)];
    const ok = await redisRequest(['set', `fcode:${c}`, id, 'NX']);
    if (ok.result) {
      const mine = await redisRequest(['set', `fcode_of:${id}`, c, 'NX']);
      if (mine.result) return c;
      await redisRequest(['del', `fcode:${c}`]);        // 同時に作られた。先にできた方を使う
      return (await redisRequest(['get', `fcode_of:${id}`])).result;
    }
  }
  throw new Error('code generation failed');
}
async function idOfCode(code) {
  const c = normCode(code);
  if (c.length !== 6) return null;
  return (await redisRequest(['get', `fcode:${c}`])).result || null;
}
async function codesOf(ids) {
  if (!ids.length) return [];
  const r = await redisPipeline(ids.map(id => ['get', `fcode_of:${id}`]));
  return r.map(x => x.result || null);
}

// ---------------------------------------------------------------- 一覧
async function sets(me) {
  const [f, inn, out, bl] = await redisPipeline([
    ['smembers', `friends:${me}`], ['smembers', `freq_in:${me}`], ['smembers', `freq_out:${me}`], ['smembers', `blocks:${me}`],
  ]);
  return { friends: f.result || [], incoming: inn.result || [], outgoing: out.result || [], blocked: bl.result || [] };
}

async function people(ids, me) {
  if (!ids.length) return [];
  const cmds = [];
  ids.forEach(id => cmds.push(['get', `fcode_of:${id}`], ['get', `sname:${id}`], ['get', `player:${id}`],
                              ['get', `seen:${id}`], ['zscore', LV.LEVEL_KEY, id], ['get', `sub:${id}`]));
  const r = await redisPipeline(cmds);
  return ids.map((id, i) => {
    const g = k => r[i * 6 + k] && r[i * 6 + k].result;
    let p = null; try { p = JSON.parse(g(2)); } catch (e) {}
    const exp = Number(g(4)) || 0;
    return {
      code: g(0) ? showCode(g(0)) : null,
      name: g(1) || (p && p.playerName) || '名無しの船長',
      level: LV.levelFromExp(exp).level,
      online: Date.now() - (Number(g(3)) || 0) < ONLINE_MS,
      seenAt: Number(g(3)) || 0,
      style: styleOf(g(5)),
    };
  });
}

async function unreadMap(me) {
  const [last, read] = await redisPipeline([['hgetall', `dm_last:${me}`], ['hgetall', `dm_read:${me}`]]);
  const toObj = a => { const o = {}; const x = a || []; for (let i = 0; i + 1 < x.length; i += 2) o[x[i]] = Number(x[i + 1]) || 0; return o; };
  const L = toObj(last.result), R = toObj(read.result);
  const out = {};
  for (const id of Object.keys(L)) out[id] = L[id] > (R[id] || 0);
  return { unread: out, lastAt: L };
}

async function meView(me) {
  const code = await codeOf(me);
  const s = await sets(me);
  const [fr, inn, out, bl] = await Promise.all([people(s.friends, me), people(s.incoming, me), people(s.outgoing, me), people(s.blocked, me)]);
  const um = await unreadMap(me);
  fr.forEach((p, i) => { p.unread = !!um.unread[s.friends[i]]; p.lastDmAt = um.lastAt[s.friends[i]] || 0; });
  const [lvRaw, subExpRaw] = await redisPipeline([['zscore', LV.LEVEL_KEY, me], ['hgetall', LV.SUBEXP_PREFIX + me]]);
  const subMonths = subExpRaw.result || [];
  let subExp = 0; for (let i = 1; i < subMonths.length; i += 2) subExp += Number(subMonths[i]) || 0;
  return {
    code: showCode(code),
    exp: Number(lvRaw.result) || 0, subExp,
    friends: fr, incoming: inn, outgoing: out, blocked: bl,
    unreadDm: fr.filter(p => p.unread).length,
  };
}

async function pollView(me) {
  const [inn, last, read, fr] = await redisPipeline([['scard', `freq_in:${me}`], ['hgetall', `dm_last:${me}`], ['hgetall', `dm_read:${me}`],
                                                    ['smembers', `friends:${me}`]]);
  const toObj = a => { const o = {}; const x = a || []; for (let i = 0; i + 1 < x.length; i += 2) o[x[i]] = Number(x[i + 1]) || 0; return o; };
  const L = toObj(last.result), R = toObj(read.result), F = new Set(fr.result || []);
  const unreadDm = Object.keys(L).filter(id => F.has(id) && L[id] > (R[id] || 0)).length;
  return { incoming: Number(inn.result) || 0, unreadDm, cbInvite: await cbIncoming(me) };
}

// ---------------------------------------------------------------- フレンド操作
async function doRequest(me, code, shadow) {
  const other = await idOfCode(code);
  if (!other) return { success: false, error: 'そのコードの人は見つかりませんでした' };
  if (other === me) return { success: false, error: '自分のコードです' };
  const [isFriend, theyBlocked, iBlocked, theyAsked, outCount, fCount] = await redisPipeline([
    ['sismember', `friends:${me}`, other], ['sismember', `blocks:${other}`, me], ['sismember', `blocks:${me}`, other],
    ['sismember', `freq_in:${me}`, other], ['scard', `freq_out:${me}`], ['scard', `friends:${me}`],
  ]);
  if (isFriend.result === 1) return { success: false, error: 'もうフレンドです' };
  if (iBlocked.result === 1) return { success: false, error: 'ブロック中の人です。先にブロックを解除してください' };
  if (Number(fCount.result) >= MAX_FRIENDS) return { success: false, error: 'フレンドは' + MAX_FRIENDS + '人までです' };
  // 相手にブロックされている・シャドウBAN中は、送れたふりをする（相手には届かない）
  if (theyBlocked.result === 1 || shadow) return { success: true, sent: true };
  if (theyAsked.result === 1) { await makeFriends(me, other); return { success: true, friends: true }; }
  if (Number(outCount.result) >= MAX_OUT_REQ) return { success: false, error: '返事待ちの申請が多すぎます。少し待ってください' };
  await redisPipeline([['sadd', `freq_in:${other}`, me], ['sadd', `freq_out:${me}`, other]]);
  return { success: true, sent: true };
}
async function makeFriends(a, b) {
  await redisPipeline([
    ['sadd', `friends:${a}`, b], ['sadd', `friends:${b}`, a],
    ['srem', `freq_in:${a}`, b], ['srem', `freq_out:${a}`, b], ['srem', `freq_in:${b}`, a], ['srem', `freq_out:${b}`, a],
  ]);
}
async function doRespond(me, code, accept) {
  const other = await idOfCode(code);
  if (!other) return { success: false, error: '見つかりませんでした' };
  const has = await redisRequest(['sismember', `freq_in:${me}`, other]);
  if (has.result !== 1) return { success: false, error: 'その申請はもうありません' };
  if (accept) { await makeFriends(me, other); return { success: true, friends: true }; }
  await redisPipeline([['srem', `freq_in:${me}`, other], ['srem', `freq_out:${other}`, me]]);
  return { success: true };
}
async function doCancel(me, code) {
  const other = await idOfCode(code);
  if (!other) return { success: false, error: '見つかりませんでした' };
  await redisPipeline([['srem', `freq_out:${me}`, other], ['srem', `freq_in:${other}`, me]]);
  return { success: true };
}
async function doUnfriend(me, code) {
  const other = await idOfCode(code);
  if (!other) return { success: false, error: '見つかりませんでした' };
  await redisPipeline([['srem', `friends:${me}`, other], ['srem', `friends:${other}`, me],
                       ['hdel', `dm_last:${me}`, other], ['hdel', `dm_last:${other}`, me]]);
  return { success: true };
}
async function doBlock(me, code) {
  const other = await idOfCode(code);
  if (!other || other === me) return { success: false, error: '見つかりませんでした' };
  await redisPipeline([
    ['sadd', `blocks:${me}`, other],
    ['srem', `friends:${me}`, other], ['srem', `friends:${other}`, me],
    ['srem', `freq_in:${me}`, other], ['srem', `freq_out:${me}`, other], ['srem', `freq_in:${other}`, me], ['srem', `freq_out:${other}`, me],
    ['hdel', `dm_last:${me}`, other], ['hdel', `dm_last:${other}`, me],
  ]);
  return { success: true };
}
async function doUnblock(me, code) {
  const other = await idOfCode(code);
  if (!other) return { success: false, error: '見つかりませんでした' };
  await redisRequest(['srem', `blocks:${me}`, other]);
  return { success: true };
}

// ---------------------------------------------------------------- 文の掃除
function cleanName(n) { return String(n || '名無しの船長').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20) || '名無しの船長'; }
function cleanText(t) {
  let s = String(t || '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (!s) return '';
  s = s.slice(0, MAX_LEN);
  // 連絡先・リンクは消す（知らない人とつながるきっかけを作らない）
  s = s.replace(/https?:\/\/\S+|www\.\S+/gi, '＊リンク＊');
  s = s.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '＊＊＊');
  s = s.replace(/(?:\d[\s-]?){10,11}/g, '＊＊＊');
  const lower = s.toLowerCase();
  for (const w of NG_WORDS) {
    let idx = lower.indexOf(w.toLowerCase());
    while (idx >= 0) {
      s = s.slice(0, idx) + '＊'.repeat(w.length) + s.slice(idx + w.length);
      idx = s.toLowerCase().indexOf(w.toLowerCase(), idx + w.length);
    }
  }
  return s;
}
async function rateOk(me) {
  const c = Number((await redisRequest(['incr', `rl:${me}`])).result) || 0;
  if (c === 1) await redisRequest(['expire', `rl:${me}`, 10]);
  return c <= 3;
}
function msgId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function convoKey(a, b) { return 'dm:' + [a, b].sort().join(':'); }

// ---------------------------------------------------------------- DM
async function dmGet(me, code) {
  const other = await idOfCode(code);
  if (!other) return { success: false, error: '見つかりませんでした' };
  const isFriend = await redisRequest(['sismember', `friends:${me}`, other]);
  if (isFriend.result !== 1) return { success: false, error: 'フレンドとだけDMできます' };
  const raw = (await redisRequest(['lrange', convoKey(me, other), 0, 99])).result || [];
  const msgs = [];
  for (const s of raw) {
    let m; try { m = JSON.parse(s); } catch (e) { continue; }
    if (m.sb && m.f !== me) continue;                 // シャドウBANの人の発言は本人にだけ
    msgs.push({ id: m.i, mine: m.f === me, t: m.t, x: m.x, g: m.g || null });
  }
  msgs.reverse();
  await redisRequest(['hset', `dm_read:${me}`, other, Date.now()]);
  return { success: true, messages: msgs };
}
async function dmSend(me, myName, code, text, shadow, image) {
  const other = await idOfCode(code);
  if (!other) return { success: false, error: '見つかりませんでした' };
  const [isFriend, theyBlocked] = await redisPipeline([['sismember', `friends:${me}`, other], ['sismember', `blocks:${other}`, me]]);
  if (isFriend.result !== 1) return { success: false, error: 'フレンドとだけDMできます' };
  const x = cleanText(text);
  if (!x && !image) return { success: false, error: '何か書いてください' };
  if (!(await rateOk(me))) return { success: false, error: '送るのが速すぎます。少し待ってください' };
  let g = null;
  if (image) { const up = await storeImage(me, image); if (up.error) return { success: false, error: up.error }; g = up.id; }
  const now = Date.now();
  const m = { i: msgId(), f: me, t: now, x };
  if (g) m.g = g;
  if (shadow || theyBlocked.result === 1) m.sb = 1;  // 相手には見えない
  const key = convoKey(me, other);
  const cmds = [['lpush', key, JSON.stringify(m)], ['ltrim', key, 0, DM_KEEP - 1], ['hset', `dm_read:${me}`, other, now]];
  if (!m.sb) cmds.push(['hset', `dm_last:${other}`, me, now], ['set', 'dml:' + key, now, 'EX', 90 * 86400]);
  await redisPipeline(cmds);
  return { success: true, message: { id: m.i, mine: true, t: now, x, g } };
}

// ---------------------------------------------------------------- 談話室
async function loungeGet(me, since) {
  const [raw, bl] = await redisPipeline([['lrange', 'lounge:s2', 0, 99], ['smembers', `blocks:${me}`]]);
  const blocked = new Set(bl.result || []);
  const msgs = [];
  for (const s of raw.result || []) {
    let m; try { m = JSON.parse(s); } catch (e) { continue; }
    if (m.t <= since) continue;
    if (m.sb && m.f !== me) continue;
    if (blocked.has(m.f)) continue;
    msgs.push({ id: m.i, mine: m.f === me, t: m.t, x: m.x, g: m.g || null, name: m.n, code: m.c ? showCode(m.c) : null, lv: m.lv || 1, style: m.s || null });
  }
  msgs.reverse();
  return { success: true, messages: msgs };
}
async function loungeSend(me, myName, text, shadow, image) {
  const x = cleanText(text);
  if (!x && !image) return { success: false, error: '何か書いてください' };
  if (!(await rateOk(me))) return { success: false, error: '送るのが速すぎます。少し待ってください' };
  let g = null;
  if (image) { const up = await storeImage(me, image); if (up.error) return { success: false, error: up.error }; g = up.id; }
  const [c, lv, sub] = await redisPipeline([['get', `fcode_of:${me}`], ['zscore', LV.LEVEL_KEY, me], ['get', `sub:${me}`]]);
  const m = { i: msgId(), f: me, t: Date.now(), x, n: cleanText(myName).slice(0, 20) || '名無しの船長', c: c.result || null,
              lv: LV.levelFromExp(Number(lv.result) || 0).level, s: styleOf(sub.result) };
  if (g) m.g = g;
  if (shadow) m.sb = 1;
  const lc = [['lpush', 'lounge:s2', JSON.stringify(m)], ['ltrim', 'lounge:s2', 0, LOUNGE_KEEP - 1]];
  if (!shadow) lc.push(['set', 'lounge:s2:last', m.t]);
  await redisPipeline(lc);
  return { success: true, message: { id: m.i, mine: true, t: m.t, x, g, name: m.n, code: m.c ? showCode(m.c) : null, lv: m.lv, style: m.s } };
}

// ---------------------------------------------------------------- 画像（超魁プラン）
const IMG_MAX_BYTES = 160 * 1024;
const IMG_PER_DAY = 20;
const IMG_TTL = 30 * 86400;
async function storeImage(me, dataUrl) {
  const sub = await redisRequest(['get', `sub:${me}`]);
  let sp = null; try { sp = JSON.parse(sub.result); } catch (e) {}
  if (!sp || !(sp.until > Date.now()) || (PLAN_LEVEL[sp.plan] || 0) < 4) return { error: '画像を送れるのは超魁プランの人だけです' };
  const mt = /^data:(image\/(?:jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(dataUrl || ''));
  if (!mt) return { error: '画像の形式が違います' };
  const buf = Buffer.from(mt[2], 'base64');
  if (!buf.length || buf.length > IMG_MAX_BYTES) return { error: '画像が大きすぎます' };
  const isJpeg = buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
  const isWebp = buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP';
  if (!(mt[1] === 'image/jpeg' ? isJpeg : isWebp)) return { error: '画像の形式が違います' };
  const day = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const dk = `imgday:${me}:${day}`;
  const c = Number((await redisRequest(['incr', dk])).result) || 0;
  if (c === 1) await redisRequest(['expire', dk, 2 * 86400]);
  if (c > IMG_PER_DAY) return { error: '画像は1日' + IMG_PER_DAY + '枚までです' };
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  await redisRequest(['set', `img:${id}`, JSON.stringify({ t: mt[1], d: mt[2], f: me }), 'EX', IMG_TTL]);
  return { id };
}
async function serveImage(id, res) {
  if (!/^[a-z0-9]{8,24}$/.test(id)) return res.status(400).json({ error: 'Bad id' });
  const r = await redisRequest(['get', `img:${id}`]);
  let o = null; try { o = JSON.parse(r.result); } catch (e) {}
  if (!o || !o.d) return res.status(404).json({ error: 'この画像は消えました' });
  const buf = Buffer.from(o.d, 'base64');
  res.setHeader('Content-Type', o.t === 'image/webp' ? 'image/webp' : 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.statusCode = 200;
  return res.end(buf);
}

// ---------------------------------------------------------------- 通報
async function doReport(me, body) {
  const kind = body.kind === 'dm' ? 'dm' : 'lounge';
  const reason = cleanText(body.reason || '').slice(0, 100);
  const now = Date.now();
  let entry;
  if (kind === 'dm') {
    const other = await idOfCode(body.code);
    if (!other) return { success: false, error: '見つかりませんでした' };
    const key = convoKey(me, other);
    const raw = (await redisRequest(['lrange', key, 0, DM_KEEP - 1])).result || [];
    let target = null;
    for (const s of raw) { try { const m = JSON.parse(s); if (m.i === body.msgId) { target = m; break; } } catch (e) {} }
    entry = { at: now, kind, reporter: me, target: other, convo: key, msgId: body.msgId || null, text: target ? target.x : null, img: target && target.g || null, reason };
    await redisRequest(['sadd', 'reported_convos', key]);
  } else {
    const raw = (await redisRequest(['lrange', 'lounge:s2', 0, LOUNGE_KEEP - 1])).result || [];
    let target = null;
    for (const s of raw) { try { const m = JSON.parse(s); if (m.i === body.msgId) { target = m; break; } } catch (e) {} }
    if (!target) return { success: false, error: 'その発言は見つかりませんでした' };
    entry = { at: now, kind, reporter: me, target: target.f, msgId: target.i, text: target.x, img: target.g || null, name: target.n, reason };
  }
  await redisPipeline([['lpush', 'social_reports', JSON.stringify(entry)], ['ltrim', 'social_reports', 0, 499]]);
  return { success: true };
}

// ---------------------------------------------------------------- 浦賀沖大砲戦（オンライン対戦・1対1）
// 形：おたがい自分の海で戦い、敵を倒すと相手の海に「おじゃま小舟」を送り込める。先に沈んだ方が負け。
//  cbt_find   { ticket? }        … 誰かと対戦。待っている人がいればその場で対戦、いなければ待つ（1.5秒おきに呼び直す）
//  cbt_cancel { ticket?, inviteId? }
//  cbt_invite { code }           … フレンドを誘う（フレンドどうしだけ。3分で消える）
//  cbt_invite_poll { inviteId }  … 誘った側：相手が受けたか
//  cbt_incoming                  … 誘われているか（poll にも入っている）
//  cbt_answer { inviteId, accept }
//  cbt_sync   { matchId, key, opp, state } … 対戦中。自分の様子を書いて、相手の様子を読む
// 勝ち負けは見た目と実績だけに使う（隻数は動かない）ので、細かい不正対策はしていない。
const crypto = require('crypto');
const CB_HEX = /^[0-9a-f]{16}$/;
function rid() { return crypto.randomBytes(8).toString('hex'); }
async function cbProfile(id) {
  const [nm, lv] = await redisPipeline([['get', `sname:${id}`], ['zscore', LV.LEVEL_KEY, id]]);
  return { name: nm.result || '名無しの船長', lv: LV.levelFromExp(Number(lv.result) || 0).level };
}
async function cbCreate(aId, bId) {
  const matchId = rid(), ka = rid(), kb = rid(), seed = crypto.randomBytes(4).readUInt32BE(0);
  const [pa, pb] = await Promise.all([cbProfile(aId), cbProfile(bId)]);
  const startAt = Date.now() + 5000;     // 5秒後に一斉に始める
  return {
    a: { matchId, key: ka, opp: kb, oppName: pb.name, oppLv: pb.lv, seed, startAt },
    b: { matchId, key: kb, opp: ka, oppName: pa.name, oppLv: pa.lv, seed, startAt },
  };
}
async function cbBlocked(a, b) {
  const [x, y] = await redisPipeline([['sismember', `blocks:${a}`, b], ['sismember', `blocks:${b}`, a]]);
  return x.result === 1 || y.result === 1;
}
function jparse(s) { try { return JSON.parse(s); } catch (e) { return null; } }

async function cbFind(me, ticket) {
  if (ticket && !CB_HEX.test(ticket)) ticket = null;
  if (ticket) {
    const mine = jparse((await redisRequest(['get', `cbt:tk:${ticket}`])).result);
    if (mine && mine.pid === me && mine.match) {
      await redisRequest(['del', `cbt:tk:${ticket}`]);
      return { success: true, status: 'matched', match: mine.match, now: Date.now() };
    }
  }
  // 組み合わせは同時に1人だけが行う（2人が同時に探して食い違わないように）
  const lock = await redisRequest(['set', 'cbt:lock', me, 'NX', 'PX', 2000]);
  if (!lock.result) return { success: true, status: 'waiting', ticket: ticket || null, now: Date.now() };
  try {
    const w = (await redisRequest(['get', 'cbt:wait'])).result;
    if (w && w !== ticket) {
      const other = jparse((await redisRequest(['get', `cbt:tk:${w}`])).result);
      if (other && other.pid && other.pid !== me && !other.match && !(await cbBlocked(me, other.pid))) {
        const m = await cbCreate(other.pid, me);
        const cmds = [['set', `cbt:tk:${w}`, JSON.stringify({ pid: other.pid, match: m.a }), 'EX', 60], ['del', 'cbt:wait']];
        if (ticket) cmds.push(['del', `cbt:tk:${ticket}`]);
        await redisPipeline(cmds);
        return { success: true, status: 'matched', match: m.b, now: Date.now() };
      }
      if (other && other.pid && other.pid !== me && !other.match) {
        // ブロックし合っている相手とは組まない。順番を待つ
        return { success: true, status: 'waiting', ticket: ticket || null, now: Date.now() };
      }
    }
    const t = ticket || rid();
    await redisPipeline([['set', `cbt:tk:${t}`, JSON.stringify({ pid: me }), 'EX', 15], ['set', 'cbt:wait', t, 'EX', 15]]);
    return { success: true, status: 'waiting', ticket: t, now: Date.now() };
  } finally {
    await redisRequest(['del', 'cbt:lock']);
  }
}
async function cbCancel(me, body) {
  const cmds = [];
  if (body.ticket && CB_HEX.test(body.ticket)) {
    const w = (await redisRequest(['get', 'cbt:wait'])).result;
    if (w === body.ticket) cmds.push(['del', 'cbt:wait']);
    cmds.push(['del', `cbt:tk:${body.ticket}`]);
  }
  if (body.inviteId && CB_HEX.test(body.inviteId)) {
    const inv = jparse((await redisRequest(['get', `cbt:inv:${body.inviteId}`])).result);
    if (inv && inv.from === me) cmds.push(['del', `cbt:inv:${body.inviteId}`], ['del', `cbt:invto:${inv.to}`]);
  }
  if (cmds.length) await redisPipeline(cmds);
  return { success: true };
}
async function cbInvite(me, myName, code) {
  const other = await idOfCode(code);
  if (!other || other === me) return { success: false, error: '見つかりませんでした' };
  const fr = await redisRequest(['sismember', `friends:${me}`, other]);
  if (fr.result !== 1) return { success: false, error: 'フレンドだけ誘えます' };
  if (await cbBlocked(me, other)) return { success: false, error: '誘えませんでした' };
  const id = rid(), now = Date.now();
  const inv = { from: me, to: other, fromName: cleanName(myName), at: now };
  const key = convoKey(me, other);
  const note = { i: msgId(), f: me, t: now, x: '⚔️ 浦賀沖大砲戦に誘っています！3分以内にメニューの「💥 浦賀沖大砲戦」を開いてね。' };
  await redisPipeline([
    ['set', `cbt:inv:${id}`, JSON.stringify(inv), 'EX', 180],
    ['set', `cbt:invto:${other}`, id, 'EX', 180],
    // 気づいてもらえるように、DMにも一言残す
    ['lpush', key, JSON.stringify(note)], ['ltrim', key, 0, DM_KEEP - 1],
    ['hset', `dm_last:${other}`, me, now], ['hset', `dm_read:${me}`, other, now], ['set', 'dml:' + key, now, 'EX', 90 * 86400],
  ]);
  return { success: true, inviteId: id };
}
async function cbInvitePoll(me, id) {
  if (!id || !CB_HEX.test(id)) return { success: false, error: 'Bad id' };
  const inv = jparse((await redisRequest(['get', `cbt:inv:${id}`])).result);
  if (!inv) return { success: true, status: 'expired' };
  if (inv.from !== me) return { success: false, error: 'Forbidden' };
  if (inv.match) { await redisRequest(['del', `cbt:inv:${id}`]); return { success: true, status: 'matched', match: inv.match, now: Date.now() }; }
  if (inv.declined) { await redisRequest(['del', `cbt:inv:${id}`]); return { success: true, status: 'declined' }; }
  return { success: true, status: 'waiting' };
}
async function cbIncoming(me) {
  const id = (await redisRequest(['get', `cbt:invto:${me}`])).result;
  if (!id) return null;
  const inv = jparse((await redisRequest(['get', `cbt:inv:${id}`])).result);
  if (!inv || inv.to !== me || inv.match || inv.declined) return null;
  return { id, fromName: inv.fromName, at: inv.at };
}
async function cbAnswer(me, id, accept) {
  if (!id || !CB_HEX.test(id)) return { success: false, error: 'Bad id' };
  const inv = jparse((await redisRequest(['get', `cbt:inv:${id}`])).result);
  if (!inv || inv.to !== me || inv.match || inv.declined) return { success: false, error: 'この誘いはもう終わっています' };
  if (!accept) {
    inv.declined = true;
    await redisPipeline([['set', `cbt:inv:${id}`, JSON.stringify(inv), 'EX', 60], ['del', `cbt:invto:${me}`]]);
    return { success: true, status: 'declined' };
  }
  const m = await cbCreate(inv.from, me);
  inv.match = m.a;
  await redisPipeline([['set', `cbt:inv:${id}`, JSON.stringify(inv), 'EX', 60], ['del', `cbt:invto:${me}`]]);
  return { success: true, status: 'matched', match: m.b, now: Date.now() };
}
function cbClamp(v, lo, hi) { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo; }
async function cbSync(body) {
  const { matchId, key, opp } = body;
  if (![matchId, key, opp].every(x => typeof x === 'string' && CB_HEX.test(x)) || key === opp) return { success: false, error: 'Bad keys' };
  const s = body.state || {};
  const now = Date.now();
  const st = { hp: cbClamp(s.hp, 0, 10), score: cbClamp(s.score, 0, 1e7), kills: cbClamp(s.kills, 0, 1e5), sent: cbClamp(s.sent, 0, 1e4),
               t: cbClamp(s.t, 0, 600), alive: s.alive !== false, done: !!s.done, at: now };
  const [, o] = await redisPipeline([['set', `cbs:${matchId}:${key}`, JSON.stringify(st), 'EX', 900], ['get', `cbs:${matchId}:${opp}`]]);
  return { success: true, opp: jparse(o && o.result), now };
}

// ---------------------------------------------------------------- 目安箱
const IDEA_KINDS = ['want', 'fix', 'other'];
const IDEA_STATUS = ['new', 'read', 'plan', 'done', 'no'];   // 届いた・読んだ・やる予定・やった！・見送り
const IDEA_MAX = 500, IDEA_REPLY_MAX = 300, IDEA_PER_DAY = 5, IDEA_KEEP = 2000, IDEA_TTL = 400 * 86400;
const IDEA_ID = /^[0-9a-f]{16}$/;
function ideaView(o) { return { id: o.i, kind: o.k, text: o.x, at: o.t, status: o.s, reply: o.r || '', updatedAt: o.u || o.t }; }
async function ideaSend(me, myName, kind, text) {
  if (!IDEA_KINDS.includes(kind)) kind = 'other';
  const x = String(text || '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\n{4,}/g, '\n\n\n').trim().slice(0, IDEA_MAX);
  if (x.length < 5) return { success: false, error: 'もう少しくわしく書いてね（5文字以上）' };
  const cool = await redisRequest(['set', `idea_cd:${me}`, 1, 'NX', 'EX', 60]);
  if (cool.result !== 'OK') return { success: false, error: '続けて送るときは、1分あけてね' };
  const day = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);   // 日本の日付
  const [n, , sb] = await redisPipeline([['incr', `idea_n:${me}:${day}`], ['expire', `idea_n:${me}:${day}`, 2 * 86400], ['sismember', 'shadow_banned_players', me]]);
  if (Number(n.result) > IDEA_PER_DAY) return { success: false, error: '目安箱は1日' + IDEA_PER_DAY + '通までです。また明日送ってね' };
  const now = Date.now(), id = rid();
  const o = { i: id, f: me, n: cleanName(myName), k: kind, x, t: now, s: 'new', r: '', u: now };
  if (sb.result === 1) o.sb = 1;   // 管理画面で分かるように印だけ付ける
  await redisPipeline([
    ['set', `idea:${id}`, JSON.stringify(o), 'EX', IDEA_TTL],
    ['zadd', 'ideas:all', now, id],
    ['zremrangebyrank', 'ideas:all', 0, -(IDEA_KEEP + 1)],
    ['lpush', `ideas_of:${me}`, id], ['ltrim', `ideas_of:${me}`, 0, 49], ['expire', `ideas_of:${me}`, IDEA_TTL],
  ]);
  return { success: true, idea: ideaView(o) };
}
async function ideaMine(me) {
  const ids = ((await redisRequest(['lrange', `ideas_of:${me}`, 0, 49])).result || []).filter(id => IDEA_ID.test(id));
  if (!ids.length) return { success: true, ideas: [] };
  const got = await redisPipeline(ids.map(id => ['get', `idea:${id}`]));
  return { success: true, ideas: got.map(g => jparse(g && g.result)).filter(o => o && o.f === me).map(ideaView) };
}

// ---------------------------------------------------------------- 管理
async function admin(body, res) {
  const SECRET = process.env.ADMIN_SECRET;
  if (!SECRET || body.secret !== SECRET) return res.status(403).json({ error: 'Forbidden' });
  if (body.action === 'admin_reports') {
    const raw = (await redisRequest(['lrange', 'social_reports', 0, 199])).result || [];
    const list = raw.map(s => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
    const ids = [...new Set(list.flatMap(r => [r.reporter, r.target]).filter(Boolean))];
    const names = ids.length ? await redisPipeline(ids.map(id => ['get', `sname:${id}`])) : [];
    const nameOf = {}; ids.forEach((id, i) => { nameOf[id] = names[i].result || null; });
    list.forEach(r => { r.reporterName = nameOf[r.reporter]; r.targetName = nameOf[r.target]; });
    return res.status(200).json({ success: true, reports: list });
  }
  if (body.action === 'admin_dm') {
    const key = String(body.convo || '');
    const ok = await redisRequest(['sismember', 'reported_convos', key]);
    if (ok.result !== 1) return res.status(403).json({ error: '通報されていない会話は読めません' });
    const raw = (await redisRequest(['lrange', key, 0, DM_KEEP - 1])).result || [];
    const msgs = raw.map(s => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean).reverse();
    const ids = [...new Set(msgs.map(m => m.f))];
    const names = ids.length ? await redisPipeline(ids.map(id => ['get', `sname:${id}`])) : [];
    const nameOf = {}; ids.forEach((id, i) => { nameOf[id] = names[i].result || id; });
    return res.status(200).json({ success: true, messages: msgs.map(m => ({ from: m.f, name: nameOf[m.f], t: m.t, x: m.x, g: m.g || null, hidden: !!m.sb, id: m.i })) });
  }
  if (body.action === 'admin_lounge_delete') {
    const raw = (await redisRequest(['lrange', 'lounge:s2', 0, LOUNGE_KEEP - 1])).result || [];
    const hit = raw.find(s => { try { return JSON.parse(s).i === body.msgId; } catch (e) { return false; } });
    if (!hit) return res.status(404).json({ error: 'Not found' });
    await redisRequest(['lrem', 'lounge:s2', 1, hit]);
    return res.status(200).json({ success: true });
  }
  if (body.action === 'admin_img_delete') {
    const id = String(body.imgId || '');
    if (!/^[a-z0-9]{8,24}$/.test(id)) return res.status(400).json({ error: 'Bad id' });
    await redisRequest(['del', `img:${id}`]);
    return res.status(200).json({ success: true });
  }
  if (body.action === 'admin_mute' || body.action === 'admin_unmute') {
    const id = String(body.playerId || '');
    if (!id) return res.status(400).json({ error: 'Missing playerId' });
    await redisRequest([body.action === 'admin_mute' ? 'sadd' : 'srem', 'social_muted', id]);
    return res.status(200).json({ success: true, muted: body.action === 'admin_mute' });
  }
  if (body.action === 'admin_ideas') {
    const ids = ((await redisRequest(['zrevrange', 'ideas:all', 0, 499])).result || []).filter(id => IDEA_ID.test(id));
    const got = ids.length ? await redisPipeline(ids.map(id => ['get', `idea:${id}`])) : [];
    let list = got.map(g => jparse(g && g.result)).filter(Boolean);
    if (body.open) list = list.filter(o => o.s !== 'done' && o.s !== 'no');
    const pids = [...new Set(list.map(o => o.f))];
    const names = pids.length ? await redisPipeline(pids.map(id => ['get', `sname:${id}`])) : [];
    const nameOf = {}; pids.forEach((id, i) => { nameOf[id] = names[i].result || null; });
    return res.status(200).json({ success: true, ideas: list.map(o => ({ ...ideaView(o), playerId: o.f, name: nameOf[o.f] || o.n, nameAtSend: o.n, shadow: !!o.sb })) });
  }
  if (body.action === 'admin_idea_set') {
    const id = String(body.id || '');
    if (!IDEA_ID.test(id)) return res.status(400).json({ error: 'Bad id' });
    const o = jparse((await redisRequest(['get', `idea:${id}`])).result);
    if (!o) return res.status(404).json({ error: 'Not found' });
    if (body.status != null) { if (!IDEA_STATUS.includes(body.status)) return res.status(400).json({ error: 'Bad status' }); o.s = body.status; }
    if (body.reply != null) o.r = String(body.reply).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, IDEA_REPLY_MAX);
    o.u = Date.now();
    await redisRequest(['set', `idea:${id}`, JSON.stringify(o), 'EX', IDEA_TTL]);
    return res.status(200).json({ success: true, idea: ideaView(o) });
  }
  if (body.action === 'admin_idea_delete') {
    const id = String(body.id || '');
    if (!IDEA_ID.test(id)) return res.status(400).json({ error: 'Bad id' });
    await redisPipeline([['del', `idea:${id}`], ['zrem', 'ideas:all', id]]);
    return res.status(200).json({ success: true });
  }
  return res.status(400).json({ error: 'Unknown admin action' });
}

// 加入プラン（明治以上）の名前の色・フォント
const PLAN_LEVEL = { edo: 1, meiji: 2, sakigake: 3, cho: 4 };
function styleOf(raw) {
  if (!raw) return null;
  let s; try { s = JSON.parse(raw); } catch (e) { return null; }
  if (!s || !(s.until > Date.now()) || (PLAN_LEVEL[s.plan] || 0) < 2) return null;
  const e = SS.effectiveStyle(s.style, s.plan);
  return { plan: s.plan, color: e.color, font: e.font };
}
