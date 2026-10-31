// =====================================================================
// 幕末大乱闘：リアルタイム対戦サーバー（Cloudflare Workers + Durable Objects）
//
//   GET /ws      … WebSocket。つないだら {t:'hello', mode, name, char, lv, practice} を送る
//   GET /health  … 生きているか
//
// 全員を「Hub」という1つの Durable Object につなぐ。Hub が順番待ちと試合（部屋）をまとめて受け持つ。
// クラスで遊ぶくらいの人数なら1つで十分（同時に何試合でも回せる）。
//
// 順番待ち：人がそろえばすぐ始める。そろわなければ 6 秒待って、空いた枠に CPU を入れて始める。
// 練習（practice）：待たずに CPU と始める。
// 試合中に人が抜けたら、その席は CPU が引き継ぐ。人が全員いなくなったら部屋を片付ける。
// =====================================================================
import { Room, TICK, CHARS, CHAR_IDS } from './sim.js';

const NEED = { kemari: 6, ikki: 6 };
const WAIT_MS = 6000;
const MAX_CONNS = 400;    // つなげる人数の上限（いたずらで重くされないように）
const MAX_ROOMS = 60;     // 同時に動かす試合の上限
const BOT_NAMES = ['足軽の太郎', '足軽の次郎', '浪人の三郎', '町娘のお花', '飛脚の源', '漁師の権兵衛', '大工の八', '絵師の北斎もどき', '奉行所の与力', '旅の僧'];

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = { 'Access-Control-Allow-Origin': '*' };
    if (url.pathname === '/health') return new Response('ok', { headers: cors });
    if (url.pathname === '/ws') {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket only', { status: 426, headers: cors });
      const hub = env.HUB.get(env.HUB.idFromName('main'));
      return hub.fetch(req);
    }
    return new Response('幕末大乱闘 server', { headers: cors });
  },
};

export class Hub {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env;
    this.conns = new Map();            // ws → { key, name, lv, char, mode, room, pid }
    this.queues = { kemari: [], ikki: [] };
    this.rooms = new Map();            // roomId → { room, sockets: Map<pid, ws> }
    this.timer = null; this.seq = 1;
  }

  async fetch(req) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    if (this.conns.size >= MAX_CONNS) { this.send(server, { t: 'busy' }); server.close(1013, 'busy'); return new Response(null, { status: 101, webSocket: client }); }
    const info = { key: 'c' + (this.seq++), name: '名無しの船長', lv: 1, char: 'sailor', mode: null, room: null, pid: 0, lastMsg: Date.now(), msgs: 0, msgT: Date.now() };
    this.conns.set(server, info);
    server.addEventListener('message', (e) => this.onMessage(server, e.data));
    server.addEventListener('close', () => this.onClose(server));
    server.addEventListener('error', () => this.onClose(server));
    this.send(server, { t: 'hi', chars: CHARS });
    return new Response(null, { status: 101, webSocket: client });
  }

  send(ws, obj) { try { ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); } catch (e) {} }

  onMessage(ws, data) {
    const info = this.conns.get(ws); if (!info) return;
    // 送りすぎを止める（1秒に60通まで）
    const now = Date.now();
    if (now - info.msgT > 1000) { info.msgT = now; info.msgs = 0; }
    if (++info.msgs > 60) return;
    let m; try { m = JSON.parse(data); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'hello') {
      if (info.room) return;
      info.name = String(m.name || '名無しの船長').replace(/[\u0000-\u001f<>]/g, '').slice(0, 12) || '名無しの船長';
      info.lv = Math.max(1, Math.min(9999, Math.floor(Number(m.lv) || 1)));
      info.char = CHARS[m.char] ? m.char : 'sailor';
      info.mode = NEED[m.mode] ? m.mode : 'kemari';
      this.leaveQueue(ws);
      if (m.practice) { this.startRoom(info.mode, [ws]); return; }
      this.queues[info.mode].push({ ws, at: now });
      this.tryMatch(info.mode, false);
      this.ensureTimer();
      return;
    }
    if (m.t === 'cancel') { this.leaveQueue(ws); this.send(ws, { t: 'cancelled' }); return; }
    const R = info.room && this.rooms.get(info.room); if (!R) return;
    if (m.t === 'mv') R.room.move(info.pid, Number(m.x) || 0, Number(m.y) || 0);
    else if (m.t === 'fire') R.room.fire(info.pid, Number(m.x) || 0, Number(m.y) || 0);
    else if (m.t === 'sup') R.room.superAt(info.pid, Number(m.x) || 0, Number(m.y) || 0, Number(m.d) || 0);
    else if (m.t === 'leave') this.leaveRoom(ws, true);
  }

  onClose(ws) {
    this.leaveQueue(ws);
    this.leaveRoom(ws, false);
    this.conns.delete(ws);
  }

  leaveQueue(ws) {
    for (const k of Object.keys(this.queues)) this.queues[k] = this.queues[k].filter(q => q.ws !== ws);
  }
  leaveRoom(ws, tellMe) {
    const info = this.conns.get(ws); if (!info || !info.room) return;
    const R = this.rooms.get(info.room);
    info.room = null;
    if (!R) return;
    R.sockets.delete(info.pid);
    const p = R.room.players.get(info.pid);
    if (p && R.room.phase !== 'end') { p.bot = true; p.name = p.name + '（CPU）'; this.broadcast(R, { t: 'roster', roster: R.room.roster() }); }
    if (tellMe) this.send(ws, { t: 'left' });
    if (!R.sockets.size) this.rooms.delete(R.room.id);
  }

  tryMatch(mode, timeUp) {
    const Q = this.queues[mode];
    // つながっていない人を外す
    this.queues[mode] = Q.filter(q => this.conns.has(q.ws));
    const q = this.queues[mode];
    if (!q.length) return;
    if (q.length >= NEED[mode] || (timeUp && Date.now() - q[0].at >= WAIT_MS)) {
      const take = q.splice(0, NEED[mode]);
      this.startRoom(mode, take.map(x => x.ws));
    } else {
      for (const x of q) this.send(x.ws, { t: 'queue', n: q.length, need: NEED[mode], wait: Math.max(0, Math.ceil((WAIT_MS - (Date.now() - q[0].at)) / 1000)) });
    }
  }

  startRoom(mode, sockets) {
    if (this.rooms.size >= MAX_ROOMS) { for (const ws of sockets) this.send(ws, { t: 'busy' }); return; }
    const id = 'r' + (this.seq++);
    const room = new Room(mode, id);
    const R = { room, sockets: new Map() };
    this.rooms.set(id, R);
    // 人を入れる（蹴鞠は交互にチーム分け）
    sockets.forEach((ws, i) => {
      const info = this.conns.get(ws); if (!info) return;
      const p = room.addPlayer({ key: info.key, name: info.name, char: info.char, lv: info.lv, team: i % 2 });
      info.room = id; info.pid = p.id; R.sockets.set(p.id, ws);
    });
    // 空いた枠は CPU
    const names = BOT_NAMES.slice().sort(() => Math.random() - 0.5);
    let n = room.players.size;
    while (n < NEED[mode]) {
      const team = mode === 'kemari' ? ([...room.players.values()].filter(p => p.team === 0).length <= [...room.players.values()].filter(p => p.team === 1).length ? 0 : 1) : 0;
      room.addPlayer({ name: names[n % names.length], char: CHAR_IDS[Math.floor(Math.random() * CHAR_IDS.length)], bot: true, lv: 1 + Math.floor(Math.random() * 8), team });
      n++;
    }
    for (const [pid, ws] of R.sockets) this.send(ws, room.startInfo(pid));
    this.ensureTimer();
  }

  broadcast(R, obj) { const s = JSON.stringify(obj); for (const ws of R.sockets.values()) this.send(ws, s); }

  ensureTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => this.loop(), 1000 / TICK);
  }
  loop() {
    for (const mode of Object.keys(this.queues)) this.tryMatch(mode, true);
    for (const [id, R] of this.rooms) {
      const room = R.room;
      room.step();
      const snap = room.snapshot(room.tick % (TICK * 5) === 0);   // 5秒に1回は箱の様子も全部送る
      this.broadcast(R, snap);
      room.events = [];
      if (room.phase === 'end') {
        room.endT = (room.endT || 0) + 1;
        if (room.endT > TICK * 3) { for (const ws of R.sockets.values()) { const info = this.conns.get(ws); if (info) info.room = null; } this.rooms.delete(id); }
      }
    }
    const anyQueue = Object.values(this.queues).some(q => q.length);
    if (!this.rooms.size && !anyQueue) { clearInterval(this.timer); this.timer = null; }
  }
}
