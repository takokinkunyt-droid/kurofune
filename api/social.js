const { redisRequest, redisPipeline, parseBody, CORS } = require('./_redis');
const LV = require('./_level');

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
    if (action === 'me' || action === 'poll') {
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
  return { incoming: Number(inn.result) || 0, unreadDm };
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
  return res.status(400).json({ error: 'Unknown admin action' });
}

// 加入プラン（明治以上）の名前の色・フォント
const PLAN_LEVEL = { edo: 1, meiji: 2, sakigake: 3, cho: 4 };
function styleOf(raw) {
  if (!raw) return null;
  let s; try { s = JSON.parse(raw); } catch (e) { return null; }
  if (!s || !(s.until > Date.now()) || (PLAN_LEVEL[s.plan] || 0) < 2) return null;
  const st = s.style || {};
  return { plan: s.plan, color: st.color || 'default', font: st.font || 'default' };
}
