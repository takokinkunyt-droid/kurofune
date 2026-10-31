// =====================================================================
// 幕末大乱闘：試合の中身（サーバーが持つ正本）
//
// この中は Cloudflare の決まりに頼らない、ただの JavaScript。
// 1こま（TICK 分の1秒）ずつ進め、全員の様子を snapshot() で配る。
//
// ルール
//   蹴鞠 kemari … 3対3。鞠を相手のゴールへ。2点先取、または2分半で多い方。同点なら30秒の延長（次の1点で勝ち）
//   一揆 ikki   … 最大6人。箱を壊すと出る「力の玉」で強くなる。煙（役人の包囲）が狭まる。最後の1人が勝ち
// =====================================================================

export const TICK = 20;
const DT = 1 / TICK;

// ---- キャラクター ----------------------------------------------------
// atk: 通常攻撃（弾を n 発、spread の角度に広げて撃つ）。kind:'arc' は目の前を斬る近接
// sup: 必殺技。supNeed だけ相手に当てるとたまる
export const CHARS = {
  sailor: { name: '水夫', e: '🧑‍✈️', hp: 3600, speed: 235, r: 26,
            atk: { n: 3, spread: 0.24, range: 380, speed: 800, dmg: 400, w: 12 }, ammo: 3, reload: 0.9, cd: 0.4,
            sup: { kind: 'shot', n: 1, range: 540, speed: 700, dmg: 1400, w: 30, pierce: true, knock: 170 }, supNeed: 2600,
            supName: '錨投げ', desc: '3方向に撃つ。必殺技は貫く錨' },
  ninja:  { name: '忍者', e: '🥷', hp: 3000, speed: 280, r: 24,
            atk: { n: 2, spread: 0.08, range: 430, speed: 950, dmg: 520, w: 10 }, ammo: 3, reload: 0.8, cd: 0.35,
            sup: { kind: 'dash', dist: 340, dmg: 1000 }, supNeed: 2400,
            supName: '影走り', desc: '足が速い。必殺技は斬りながら駆け抜ける' },
  oni:    { name: '鬼武者', e: '👹', hp: 5400, speed: 215, r: 30,
            atk: { kind: 'arc', range: 165, half: 0.75, dmg: 1050 }, ammo: 2, reload: 1.05, cd: 0.5,
            sup: { kind: 'charge', dist: 400, dmg: 1400, knock: 220 }, supNeed: 2800,
            supName: '鬼の突進', desc: '体力が多い近接。必殺技は体当たり' },
  perry:  { name: 'ペリー', e: '🎩', hp: 2800, speed: 225, r: 25,
            atk: { n: 1, spread: 0, range: 660, speed: 1000, dmg: 1050, w: 14 }, ammo: 3, reload: 1.4, cd: 0.55,
            sup: { kind: 'lob', range: 620, radius: 150, dmg: 1700, delay: 0.85 }, supNeed: 3000,
            supName: '艦砲射撃', desc: '遠くまで届く大砲。必殺技は離れた所を吹き飛ばす' },
};
export const CHAR_IDS = Object.keys(CHARS);

// ---- 地図 ----------------------------------------------------------------
function mirrorY(walls, H) { return walls.concat(walls.map(w => ({ x: w.x, y: H - w.y - w.h, w: w.w, h: w.h }))); }
export const MAPS = {
  kemari: () => {
    const W = 900, H = 1500;
    const walls = mirrorY([
      { x: 280, y: 190, w: 90, h: 40 }, { x: 530, y: 190, w: 90, h: 40 },
      { x: 110, y: 470, w: 140, h: 50 }, { x: 650, y: 470, w: 140, h: 50 },
      { x: 400, y: 560, w: 100, h: 40 },
    ], H);
    return { w: W, h: H, walls, boxes: [], goal: { x0: 340, x1: 560 },
             spawns: [[[225, 1340], [450, 1400], [675, 1340]], [[225, 160], [450, 100], [675, 160]]],   // 目の前の壁にふさがれない位置
             ball: [450, 750] };
  },
  ikki: () => {
    const S = 1500;
    const walls = [
      { x: 300, y: 300, w: 160, h: 50 }, { x: 300, y: 300, w: 50, h: 160 },
      { x: 1040, y: 300, w: 160, h: 50 }, { x: 1150, y: 300, w: 50, h: 160 },
      { x: 300, y: 1150, w: 160, h: 50 }, { x: 300, y: 1040, w: 50, h: 160 },
      { x: 1040, y: 1150, w: 160, h: 50 }, { x: 1150, y: 1040, w: 50, h: 160 },
      { x: 690, y: 560, w: 120, h: 50 }, { x: 690, y: 890, w: 120, h: 50 },
      { x: 560, y: 690, w: 50, h: 120 }, { x: 890, y: 690, w: 50, h: 120 },
    ];
    const boxes = [[160, 750], [1340, 750], [750, 160], [750, 1340], [500, 500], [1000, 500], [500, 1000], [1000, 1000],
                   [750, 750], [220, 220], [1280, 220], [220, 1280], [1280, 1280]]
      .map(([x, y]) => ({ x: x - 30, y: y - 30, w: 60, h: 60, hp: 4000, alive: true }));
    const spawns = [];
    for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2 + 0.3; spawns.push([750 + Math.cos(a) * 600, 750 + Math.sin(a) * 600]); }
    return { w: S, h: S, walls, boxes, spawns };
  },
};

// ---- 小さな道具 ----------------------------------------------------------
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
function circleRect(x, y, r, b) {
  const cx = clamp(x, b.x, b.x + b.w), cy = clamp(y, b.y, b.y + b.h);
  const dx = x - cx, dy = y - cy, d2 = dx * dx + dy * dy;
  if (d2 >= r * r) return null;
  if (d2 > 0.0001) { const d = Math.sqrt(d2); return { nx: dx / d, ny: dy / d, pen: r - d }; }
  // 中心が箱の中：いちばん近い辺から外へ
  const l = x - b.x, rr = b.x + b.w - x, t = y - b.y, bt = b.y + b.h - y, m = Math.min(l, rr, t, bt);
  if (m === l) return { nx: -1, ny: 0, pen: l + r }; if (m === rr) return { nx: 1, ny: 0, pen: rr + r };
  if (m === t) return { nx: 0, ny: -1, pen: t + r }; return { nx: 0, ny: 1, pen: bt + r };
}
const inRect = (x, y, b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
function rng(seed) { let a = seed >>> 0; return () => { a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// =====================================================================
export class Room {
  constructor(mode, id, seed) {
    this.mode = mode; this.id = id; this.rand = rng(seed || (Math.random() * 4294967296) >>> 0);
    this.map = MAPS[mode]();
    this.players = new Map();   // id → player
    this.shots = []; this.lobs = []; this.cubes = []; this.events = [];
    this.tick = 0; this.time = 0;
    this.phase = 'count'; this.phaseT = 3.5;         // 3, 2, 1 のあと始まる
    this.score = [0, 0]; this.overtime = false; this.limit = mode === 'kemari' ? 150 : 210;
    this.ball = mode === 'kemari' ? { x: this.map.ball[0], y: this.map.ball[1], vx: 0, vy: 0, holder: null, lastKick: null, kickT: 0 } : null;
    this.ring = mode === 'ikki' ? { cx: this.map.w / 2, cy: this.map.h / 2, r: 1150 } : null;
    this.alive = 0; this.result = null; this.nextId = 1; this.boxHpDirty = true;
  }

  // ---- 人を入れる ----
  addPlayer({ key, name, char, bot, lv, team }) {
    const c = CHARS[char] ? char : CHAR_IDS[Math.floor(this.rand() * CHAR_IDS.length)];
    const id = this.nextId++;
    const p = { id, key, name: String(name || '名無しの船長').slice(0, 12), char: c, bot: !!bot, lv: lv || 1,
                team: this.mode === 'kemari' ? team : id, slot: 0, x: 0, y: 0, r: CHARS[c].r, ang: -Math.PI / 2,
                hp: CHARS[c].hp, maxHp: CHARS[c].hp, ammo: CHARS[c].ammo, reloadT: 0, cd: 0, sup: 0,
                mx: 0, my: 0, dead: false, respawnT: 0, lastHurt: -9, lastAct: -9, power: 0,
                dash: null, kills: 0, goals: 0, place: 0, botT: 0, botAim: null, stuckT: 0, lastPos: null };
    if (this.mode === 'kemari') { p.slot = [...this.players.values()].filter(q => q.team === team).length; }
    else p.slot = this.players.size;
    this.players.set(id, p);
    this.spawn(p);
    return p;
  }
  spawn(p) {
    const ch = CHARS[p.char];
    if (this.mode === 'kemari') { const s = this.map.spawns[p.team][p.slot % 3]; p.x = s[0]; p.y = s[1]; p.ang = p.team === 0 ? -Math.PI / 2 : Math.PI / 2; }
    else { const s = this.map.spawns[p.slot % this.map.spawns.length]; p.x = s[0]; p.y = s[1]; p.ang = Math.atan2(750 - p.y, 750 - p.x); }
    p.hp = p.maxHp = ch.hp + p.power * 400; p.ammo = ch.ammo; p.dead = false; p.dash = null; p.lastHurt = -9;
  }
  roster() { return [...this.players.values()].map(p => ({ id: p.id, name: p.name, char: p.char, team: p.team, bot: p.bot, lv: p.lv })); }
  humans() { return [...this.players.values()].filter(p => !p.bot); }

  // ---- 操作 ----
  move(id, mx, my) {
    const p = this.players.get(id); if (!p) return;
    const m = Math.hypot(mx, my); if (m > 1) { mx /= m; my /= m; }
    p.mx = Number.isFinite(mx) ? mx : 0; p.my = Number.isFinite(my) ? my : 0;
  }
  fire(id, ax, ay) {
    const p = this.players.get(id); if (!p || p.dead || this.phase !== 'play' || p.dash) return;
    if (p.cd > 0) return;
    const a = (ax || ay) ? Math.atan2(ay, ax) : p.ang;
    p.ang = a;
    // 鞠を持っているなら、攻撃のかわりに蹴る
    if (this.ball && this.ball.holder === p.id) { this.kick(p, a, 920); p.cd = 0.3; return; }
    if (p.ammo < 1) return;
    p.ammo -= 1; p.cd = CHARS[p.char].cd; p.lastAct = this.time;
    this.attack(p, CHARS[p.char].atk, a, false);
  }
  superAt(id, ax, ay, dist) {
    const p = this.players.get(id); if (!p || p.dead || this.phase !== 'play' || p.dash) return;
    const ch = CHARS[p.char]; if (p.sup < ch.supNeed) return;
    const a = (ax || ay) ? Math.atan2(ay, ax) : p.ang; p.ang = a;
    if (this.ball && this.ball.holder === p.id) { this.kick(p, a, 1350); p.sup = 0; return; }
    p.sup = 0; p.lastAct = this.time;
    const s = ch.sup;
    if (s.kind === 'shot') this.attack(p, s, a, true);
    else if (s.kind === 'dash' || s.kind === 'charge') p.dash = { a, left: s.dist, speed: s.kind === 'dash' ? 1500 : 1100, dmg: s.dmg, knock: s.knock || 0, hit: new Set() };
    else if (s.kind === 'lob') {
      const d = clamp(Number(dist) || s.range, 60, s.range);
      this.lobs.push({ x: p.x + Math.cos(a) * d, y: p.y + Math.sin(a) * d, sx: p.x, sy: p.y, t: s.delay, t0: s.delay, owner: p.id, team: p.team, dmg: s.dmg * (1 + p.power * 0.1), r: s.radius });
    }
    this.events.push(['sup', p.id]);
  }
  attack(p, atk, a, isSup) {
    const mult = 1 + p.power * 0.1;
    if (atk.kind === 'arc') {
      let hitAny = false;
      for (const q of this.players.values()) {
        if (q.dead || q.team === p.team) continue;
        const dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy);
        if (d > atk.range + q.r) continue;
        let da = Math.atan2(dy, dx) - a; while (da > Math.PI) da -= Math.PI * 2; while (da < -Math.PI) da += Math.PI * 2;
        if (Math.abs(da) <= atk.half) { this.hurt(q, atk.dmg * mult, p, isSup); hitAny = true; }
      }
      for (let i = 0; i < this.map.boxes.length; i++) {
        const b = this.map.boxes[i]; if (!b.alive) continue;
        const cx = b.x + b.w / 2, cy = b.y + b.h / 2; if (Math.hypot(cx - p.x, cy - p.y) < atk.range + 30) this.hitBox(i, atk.dmg * mult);
      }
      this.events.push(['arc', p.id, Math.round(a * 100)]);
      return hitAny;
    }
    const n = atk.n || 1;
    for (let i = 0; i < n; i++) {
      const aa = a + (n > 1 ? (i / (n - 1) - 0.5) * atk.spread * 2 : 0);
      this.shots.push({ x: p.x + Math.cos(aa) * p.r, y: p.y + Math.sin(aa) * p.r, vx: Math.cos(aa) * atk.speed, vy: Math.sin(aa) * atk.speed,
                        left: atk.range, owner: p.id, team: p.team, dmg: atk.dmg * mult, w: atk.w, pierce: !!atk.pierce, knock: atk.knock || 0,
                        sup: isSup, kind: isSup ? p.char + 'S' : p.char, hit: atk.pierce ? new Set() : null });
    }
  }
  kick(p, a, speed) {
    const b = this.ball; b.holder = null; b.lastKick = p.id; b.kickT = 0.35;
    b.x = p.x + Math.cos(a) * (p.r + 14); b.y = p.y + Math.sin(a) * (p.r + 14);
    b.vx = Math.cos(a) * speed; b.vy = Math.sin(a) * speed;
    this.events.push(['kick', p.id]);
  }

  // ---- ダメージ ----
  hurt(q, dmg, by, isSup) {
    if (q.dead || this.phase !== 'play') return;
    if (q.dash && CHARS[q.char].sup.kind === 'dash') return;   // 影走りの間は当たらない
    dmg = Math.round(dmg);
    q.hp -= dmg; q.lastHurt = this.time;
    if (by) { by.lastAct = this.time; if (!isSup) by.sup = Math.min(CHARS[by.char].supNeed, by.sup + dmg); }
    this.events.push(['hit', q.id, dmg]);
    if (q.hp <= 0) this.kill(q, by);
  }
  kill(q, by) {
    q.hp = 0; q.dead = true; q.dash = null;
    if (by && by !== q) by.kills++;
    this.events.push(['ko', q.id, by ? by.id : 0]);
    if (this.ball && this.ball.holder === q.id) { this.ball.holder = null; this.ball.vx = this.ball.vy = 0; }
    if (this.mode === 'kemari') q.respawnT = 3;
    else {
      // 一揆：倒れた人は力の玉を落とす
      q.place = this.aliveCount() + 1;
      this.cubes.push({ x: q.x, y: q.y, n: Math.max(1, Math.ceil(q.power / 2)) });
    }
  }
  hitBox(i, dmg) {
    const b = this.map.boxes[i]; if (!b.alive) return;
    b.hp -= dmg; this.boxHpDirty = true;
    if (b.hp <= 0) { b.alive = false; this.cubes.push({ x: b.x + b.w / 2, y: b.y + b.h / 2, n: 1 }); this.events.push(['box', i]); }
  }
  aliveCount() { let n = 0; for (const p of this.players.values()) if (!p.dead) n++; return n; }

  // ---- 1こま ----
  step() {
    this.tick++;   // events は配ったあとで部屋の外（Hub）が空にする
    if (this.phase === 'count') { this.phaseT -= DT; if (this.phaseT <= 0) { this.phase = 'play'; this.events.push(['go']); } this.botsThink(); return; }
    if (this.phase === 'goal') { this.phaseT -= DT; if (this.phaseT <= 0) this.resetKickoff(); return; }
    if (this.phase === 'end') return;
    this.time += DT;
    this.botsThink();
    const all = [...this.players.values()];
    for (const p of all) this.stepPlayer(p);
    this.stepShots(); this.stepLobs();
    if (this.ball) this.stepBall();
    if (this.ring) this.stepRing(all);
    // 力の玉
    for (let i = this.cubes.length - 1; i >= 0; i--) {
      const c = this.cubes[i];
      for (const p of all) if (!p.dead && Math.hypot(p.x - c.x, p.y - c.y) < p.r + 18) {
        p.power += c.n; p.maxHp += 400 * c.n; p.hp += 400 * c.n; this.cubes.splice(i, 1); this.events.push(['cube', p.id]); break;
      }
    }
    this.checkEnd();
  }
  stepPlayer(p) {
    const ch = CHARS[p.char];
    if (p.dead) {
      if (this.mode === 'kemari') { p.respawnT -= DT; if (p.respawnT <= 0) this.spawn(p); }
      return;
    }
    if (p.cd > 0) p.cd -= DT;
    if (p.ammo < ch.ammo) { p.reloadT += DT; if (p.reloadT >= ch.reload) { p.reloadT = 0; p.ammo = Math.min(ch.ammo, p.ammo + 1); } } else p.reloadT = 0;
    // 3秒何もしなければ、体力が戻る
    if (this.time - p.lastHurt > 3 && this.time - p.lastAct > 3 && p.hp < p.maxHp) p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.13 * DT);
    let vx, vy;
    if (p.dash) {
      const d = p.dash, mv = Math.min(d.left, d.speed * DT);
      vx = Math.cos(d.a) * mv / DT; vy = Math.sin(d.a) * mv / DT; d.left -= mv;
      for (const q of this.players.values()) {
        if (q.dead || q.team === p.team || d.hit.has(q.id)) continue;
        if (Math.hypot(q.x - p.x, q.y - p.y) < p.r + q.r + 10) {
          d.hit.add(q.id); this.hurt(q, d.dmg * (1 + p.power * 0.1), p, true);
          if (d.knock && !q.dead) { q.x += Math.cos(d.a) * d.knock; q.y += Math.sin(d.a) * d.knock; this.collide(q); }
        }
      }
      if (d.left <= 0.5) p.dash = null;
    } else {
      const slow = this.ball && this.ball.holder === p.id ? 0.92 : 1;
      vx = p.mx * ch.speed * slow; vy = p.my * ch.speed * slow;
      if (p.mx || p.my) p.ang = Math.atan2(p.my, p.mx);
    }
    p.x += vx * DT; p.y += vy * DT;
    const hitWall = this.collide(p);
    if (hitWall && p.dash) p.dash = null;
  }
  collide(p) {
    let hit = false;
    p.x = clamp(p.x, p.r, this.map.w - p.r); p.y = clamp(p.y, p.r, this.map.h - p.r);
    const lists = [this.map.walls, this.map.boxes];
    for (const L of lists) for (const b of L) {
      if (b.alive === false) continue;
      const c = circleRect(p.x, p.y, p.r, b);
      if (c) { p.x += c.nx * c.pen; p.y += c.ny * c.pen; hit = true; }
    }
    return hit;
  }
  stepShots() {
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i];
      const steps = 2; let gone = false;
      for (let k = 0; k < steps && !gone; k++) {
        const dx = s.vx * DT / steps, dy = s.vy * DT / steps;
        s.x += dx; s.y += dy; s.left -= Math.hypot(dx, dy);
        if (s.left <= 0 || s.x < 0 || s.y < 0 || s.x > this.map.w || s.y > this.map.h) { gone = true; break; }
        for (const b of this.map.walls) if (inRect(s.x, s.y, b)) { gone = true; break; }
        if (gone) break;
        for (let j = 0; j < this.map.boxes.length; j++) {
          const b = this.map.boxes[j]; if (!b.alive) continue;
          if (inRect(s.x, s.y, b)) { this.hitBox(j, s.dmg); if (!s.pierce) { gone = true; break; } }
        }
        if (gone) break;
        for (const q of this.players.values()) {
          if (q.dead || q.team === s.team || (s.hit && s.hit.has(q.id))) continue;
          if (Math.hypot(q.x - s.x, q.y - s.y) < q.r + s.w) {
            const by = this.players.get(s.owner);
            this.hurt(q, s.dmg, by, s.sup);
            if (s.knock && !q.dead) { const m = Math.hypot(s.vx, s.vy); q.x += s.vx / m * s.knock; q.y += s.vy / m * s.knock; this.collide(q); }
            if (s.pierce) s.hit.add(q.id); else { gone = true; break; }
          }
        }
      }
      if (gone) this.shots.splice(i, 1);
    }
  }
  stepLobs() {
    for (let i = this.lobs.length - 1; i >= 0; i--) {
      const L = this.lobs[i]; L.t -= DT;
      if (L.t > 0) continue;
      const by = this.players.get(L.owner);
      for (const q of this.players.values()) if (!q.dead && q.team !== L.team && Math.hypot(q.x - L.x, q.y - L.y) < L.r + q.r) this.hurt(q, L.dmg, by, true);
      for (let j = 0; j < this.map.boxes.length; j++) {
        const b = this.map.boxes[j]; if (b.alive && Math.hypot(b.x + b.w / 2 - L.x, b.y + b.h / 2 - L.y) < L.r + 30) this.hitBox(j, L.dmg);
      }
      this.events.push(['boom', Math.round(L.x), Math.round(L.y), L.r]);
      this.lobs.splice(i, 1);
    }
  }
  stepBall() {
    const b = this.ball, M = this.map;
    if (b.kickT > 0) b.kickT -= DT;
    if (b.holder) {
      const p = this.players.get(b.holder);
      if (!p || p.dead) { b.holder = null; }
      else { b.x = p.x + Math.cos(p.ang) * (p.r + 10); b.y = p.y + Math.sin(p.ang) * (p.r + 10); b.vx = b.vy = 0; }
    }
    if (!b.holder) {
      b.x += b.vx * DT; b.y += b.vy * DT;
      const f = Math.exp(-1.9 * DT); b.vx *= f; b.vy *= f;
      // ゴール
      const inMouth = b.x > M.goal.x0 && b.x < M.goal.x1;
      if (inMouth && b.y < 0) return this.goal(0);
      if (inMouth && b.y > M.h) return this.goal(1);
      if (b.x < 12) { b.x = 12; b.vx = Math.abs(b.vx) * 0.7; }
      if (b.x > M.w - 12) { b.x = M.w - 12; b.vx = -Math.abs(b.vx) * 0.7; }
      if (!inMouth && b.y < 12) { b.y = 12; b.vy = Math.abs(b.vy) * 0.7; }
      if (!inMouth && b.y > M.h - 12) { b.y = M.h - 12; b.vy = -Math.abs(b.vy) * 0.7; }
      for (const w of M.walls) {
        const c = circleRect(b.x, b.y, 12, w);
        if (c) { b.x += c.nx * c.pen; b.y += c.ny * c.pen; const dot = b.vx * c.nx + b.vy * c.ny; if (dot < 0) { b.vx -= 1.7 * dot * c.nx; b.vy -= 1.7 * dot * c.ny; } }
      }
      // 拾う
      const sp = Math.hypot(b.vx, b.vy);
      for (const p of this.players.values()) {
        if (p.dead || p.dash) continue;
        if (b.kickT > 0 && b.lastKick === p.id) continue;
        if (sp > 650 && b.lastKick && this.players.get(b.lastKick) && this.players.get(b.lastKick).team === p.team) continue;
        if (Math.hypot(p.x - b.x, p.y - b.y) < p.r + 16) { b.holder = p.id; b.vx = b.vy = 0; break; }
      }
    }
  }
  goal(team) {
    this.score[team]++;
    const by = this.players.get(this.ball.lastKick);
    if (by && by.team === team) by.goals++;
    this.events.push(['goal', team, by ? by.id : 0]);
    this.ball.holder = null; this.ball.vx = this.ball.vy = 0;
    if (this.score[team] >= 2 || this.overtime) { this.finish(); return; }
    this.phase = 'goal'; this.phaseT = 3;
  }
  resetKickoff() {
    for (const p of this.players.values()) { this.spawn(p); p.respawnT = 0; }
    this.shots = []; this.lobs = [];
    Object.assign(this.ball, { x: this.map.ball[0], y: this.map.ball[1], vx: 0, vy: 0, holder: null, lastKick: null, kickT: 0 });
    this.phase = 'play'; this.events.push(['go']);
  }
  stepRing(all) {
    const R = this.ring, t = this.time;
    R.r = t < 35 ? 1150 : Math.max(170, 1150 - (t - 35) * (980 / 130));
    for (const p of all) {
      if (p.dead) continue;
      if (Math.hypot(p.x - R.cx, p.y - R.cy) > R.r) { p.hp -= 1100 * DT; p.lastHurt = t; if (p.hp <= 0) this.kill(p, null); }
    }
  }
  checkEnd() {
    if (this.phase !== 'play') return;
    if (this.mode === 'kemari') {
      if (this.time >= this.limit) {
        if (this.score[0] !== this.score[1]) return this.finish();
        if (!this.overtime) { this.overtime = true; this.limit += 30; this.events.push(['ot']); return; }
        return this.finish();
      }
    } else {
      const alive = [...this.players.values()].filter(p => !p.dead);
      if (alive.length <= 1 || this.time >= this.limit) {
        alive.sort((a, b) => b.hp - a.hp).forEach((p, i) => { p.place = i + 1; });
        return this.finish();
      }
    }
  }
  finish() {
    this.phase = 'end';
    if (this.mode === 'kemari') {
      const w = this.score[0] > this.score[1] ? 0 : this.score[1] > this.score[0] ? 1 : -1;
      this.result = { mode: 'kemari', winner: w, score: this.score.slice() };
    } else {
      this.result = { mode: 'ikki', places: [...this.players.values()].map(p => [p.id, p.place || 1]) };
    }
    this.events.push(['end']);
  }

  // ---- CPU ----
  botsThink() {
    for (const p of this.players.values()) if (p.bot) this.botThink(p);
  }
  botThink(p) {
    if (p.dead) { p.mx = p.my = 0; return; }
    if (this.phase !== 'play') { p.mx = p.my = 0; return; }
    p.botT -= DT;
    const ch = CHARS[p.char], rangeOf = ch.atk.kind === 'arc' ? ch.atk.range : ch.atk.range * 0.9;
    // 一番近い敵
    let foe = null, fd = 1e9;
    for (const q of this.players.values()) { if (q.dead || q.team === p.team) continue; const d = Math.hypot(q.x - p.x, q.y - p.y); if (d < fd) { fd = d; foe = q; } }
    let tx = p.x, ty = p.y, wantShoot = foe && fd < rangeOf, shootAt = foe;
    if (this.mode === 'kemari') {
      const b = this.ball, myGoalY = p.team === 0 ? this.map.h : 0, theirGoalY = p.team === 0 ? 0 : this.map.h;
      const holder = b.holder ? this.players.get(b.holder) : null;
      if (holder === p) {
        tx = this.map.w / 2 + (this.rand() - 0.5) * 60; ty = theirGoalY;
        const dg = Math.abs(p.y - theirGoalY);
        if (dg < 430 && this.rand() < 0.25) { const ax = this.map.w / 2 + (this.rand() - 0.5) * 120 - p.x, ay = theirGoalY - p.y; this.fire(p.id, ax, ay); return; }
        wantShoot = false;
      } else if (holder && holder.team === p.team) {
        tx = holder.x + (p.slot - 1) * 160; ty = holder.y + (p.team === 0 ? -160 : 160);
      } else if (holder) {
        tx = holder.x; ty = holder.y; shootAt = holder; wantShoot = Math.hypot(holder.x - p.x, holder.y - p.y) < rangeOf;
      } else {
        // 鞠に一番近い味方のCPUが取りに行く。ほかは守りと攻め
        let nearest = null, nd = 1e9;
        for (const q of this.players.values()) if (!q.dead && q.team === p.team) { const d = Math.hypot(q.x - b.x, q.y - b.y); if (d < nd) { nd = d; nearest = q; } }
        if (nearest === p || p.slot === 0) { tx = b.x; ty = b.y; }
        else if (p.slot === 2) { tx = this.map.w / 2 + (p.x > this.map.w / 2 ? 120 : -120); ty = myGoalY + (p.team === 0 ? -260 : 260); }
        else { tx = b.x + (this.rand() - 0.5) * 200; ty = (b.y + theirGoalY) / 2; }
      }
    } else {
      const R = this.ring;
      const outside = Math.hypot(p.x - R.cx, p.y - R.cy) > R.r - 80;
      // 箱
      let box = null, bd = 1e9;
      for (let i = 0; i < this.map.boxes.length; i++) { const b = this.map.boxes[i]; if (!b.alive) continue; const d = Math.hypot(b.x + 30 - p.x, b.y + 30 - p.y); if (d < bd) { bd = d; box = b; } }
      let cube = null, cd = 1e9;
      for (const c of this.cubes) { const d = Math.hypot(c.x - p.x, c.y - p.y); if (d < cd) { cd = d; cube = c; } }
      if (outside) { tx = R.cx; ty = R.cy; }
      else if (cube && cd < 400) { tx = cube.x; ty = cube.y; }
      else if (foe && (fd < rangeOf * 1.25 || (this.time > 30 && p.hp > p.maxHp * 0.6 && fd < 650))) {   // はじめは箱を優先
        const keep = rangeOf * 0.75, dx = p.x - foe.x, dy = p.y - foe.y, d = fd || 1;
        tx = foe.x + dx / d * keep + (-dy / d) * 120 * Math.sin(this.time + p.id); ty = foe.y + dy / d * keep + (dx / d) * 120 * Math.sin(this.time + p.id);
        if (p.hp < p.maxHp * 0.3) { tx = p.x + dx / d * 300; ty = p.y + dy / d * 300; }
      } else if (box) {
        tx = box.x + 30; ty = box.y + 30;
        if (bd < rangeOf) { wantShoot = true; shootAt = { x: box.x + 30, y: box.y + 30, vx: 0, vy: 0 }; tx = p.x; ty = p.y; }
      } else { tx = R.cx; ty = R.cy; }
    }
    // 動く（ぶつかって進めないときは横へ逃げる）
    const dx = tx - p.x, dy = ty - p.y, d = Math.hypot(dx, dy);
    if (d > 20) { p.mx = dx / d; p.my = dy / d; } else { p.mx = p.my = 0; }
    if (p.lastPos && Math.hypot(p.x - p.lastPos[0], p.y - p.lastPos[1]) < 1.5 && (p.mx || p.my)) p.stuckT += DT; else p.stuckT = 0;
    p.lastPos = [p.x, p.y];
    if (p.stuckT > 0.4) { p.unstuck = { a: Math.atan2(p.my, p.mx) + (this.rand() < 0.5 ? 1.6 : -1.6), t: 0.6 }; p.stuckT = 0; }
    if (p.unstuck) { p.mx = Math.cos(p.unstuck.a); p.my = Math.sin(p.unstuck.a); p.unstuck.t -= DT; if (p.unstuck.t <= 0) p.unstuck = null; }
    // 撃つ（少しずれる。人より少し遅い）
    if (wantShoot && shootAt && p.botT <= 0 && p.ammo >= 1) {
      p.botT = 0.35 + this.rand() * 0.5;
      const lead = Math.hypot(shootAt.x - p.x, shootAt.y - p.y) / 900;
      const ax = shootAt.x + (shootAt.mx || 0) * CHARS[shootAt.char || 'sailor'].speed * lead - p.x;
      const ay = shootAt.y + (shootAt.my || 0) * CHARS[shootAt.char || 'sailor'].speed * lead - p.y;
      const a = Math.atan2(ay, ax) + (this.rand() - 0.5) * 0.3;
      this.fire(p.id, Math.cos(a), Math.sin(a));
    }
    if (foe && fd < 450 && p.sup >= ch.supNeed && this.rand() < 0.05) this.superAt(p.id, foe.x - p.x, foe.y - p.y, fd);
  }

  // ---- 配る様子（短く） ----
  snapshot(full) {
    const P = [];
    for (const p of this.players.values()) {
      const ch = CHARS[p.char];
      P.push([p.id, Math.round(p.x), Math.round(p.y), Math.max(0, Math.round(p.hp)), Math.round(p.maxHp), Math.round(p.ang * 100),
              Math.floor(p.ammo * 10) / 10, Math.round(p.sup / ch.supNeed * 100), (p.dead ? 1 : 0) | (p.dash ? 2 : 0), p.power, p.kills, p.dead ? Math.ceil(p.respawnT) : 0]);
    }
    const s = { t: 's', k: this.tick, ph: this.phase, pt: Math.ceil(this.phaseT), tl: Math.max(0, Math.ceil(this.limit - this.time)), p: P,
                sh: this.shots.map(x => [Math.round(x.x), Math.round(x.y), Math.round(Math.atan2(x.vy, x.vx) * 100), x.kind]),
                lb: this.lobs.map(L => [Math.round(L.x), Math.round(L.y), L.r, Math.round(L.t / L.t0 * 100), Math.round(L.sx), Math.round(L.sy)]),
                ev: this.events };
    if (this.ball) s.b = [Math.round(this.ball.x), Math.round(this.ball.y), this.ball.holder || 0];
    if (this.ring) s.rg = Math.round(this.ring.r);
    if (this.mode === 'kemari') { s.sc = this.score; s.ot = this.overtime ? 1 : 0; }
    if (this.cubes.length || this.mode === 'ikki') s.cu = this.cubes.map(c => [Math.round(c.x), Math.round(c.y)]);
    if (this.boxHpDirty || full) { s.bx = this.map.boxes.map(b => b.alive ? Math.max(0, Math.round(b.hp)) : 0); this.boxHpDirty = false; }
    if (this.phase === 'end') s.res = this.result;
    return s;
  }
  startInfo(meId) {
    return { t: 'start', mode: this.mode, me: meId, map: { w: this.map.w, h: this.map.h, walls: this.map.walls, boxes: this.map.boxes.map(b => ({ x: b.x, y: b.y, w: b.w, h: b.h })),
             goal: this.map.goal || null, ring: this.ring ? { cx: this.ring.cx, cy: this.ring.cy } : null },
             roster: this.roster(), chars: CHARS, tick: TICK };
  }
}
