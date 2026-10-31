// =====================================================================
// レベル（EXP）の計算。サーバー側の正本。
// index.html の computeExp / levelFromExp と同じ式にしておくこと。
//
// EXP はシーズンごとに 0 から。セーブの中の「このシーズンの記録」から数える。
//   クリック100回      … 1
//   ガチャ1回          … 5
//   実績1つ            … 20（珍しい実績は 50）
//   転生1回            … 50
//   遊んだ日（1日1回）  … 10
//   加入プラン          … 毎月 明治300・魁600・超魁1500（サーバーが月ごとに記録して足す）
//
// 次のレベルまでに必要な EXP ＝ floor(100 × いまのレベル^1.5)
// =====================================================================

const LEVEL_KEY = 'level_rank:s2';          // 次のシーズンでは名前を変える（＝0から）
const SUBEXP_PREFIX = 'subexp:s2:';
const PLAN_MONTHLY_EXP = { edo: 100, meiji: 300, sakigake: 600, cho: 1500 };   // 江戸は廃止（残っている記録のためだけに置いてある）

const RARE_ACH = new Set(['music', 'noEasy', 'perryFan', 'perryAnti', 'classicShip', 'fastClick', 'deleteSave',
  'combo10000', 'clickLover',
  'superCritBurst', 'criticalBurst', 'feverFestival', 'lastVoyage']);

function n(v, max) {
  const x = Math.floor(Number(v));
  if (!Number.isFinite(x) || x < 0) return 0;
  return Math.min(x, max);
}

// セーブから数える分（加入プランの分は含まない）
function expFromSave(save) {
  if (!save || typeof save !== 'object') return 0;
  let exp = 0;
  exp += Math.floor(n(save.s2Clicks, 5e7) / 100);
  exp += n(save.s2GachaPulls, 1e6) * 5;
  const ach = (save.s2Ach && typeof save.s2Ach === 'object') ? Object.keys(save.s2Ach).filter(k => save.s2Ach[k]).slice(0, 300) : [];
  for (const k of ach) exp += RARE_ACH.has(k) ? 50 : 20;
  exp += n(save.reincarnationCount, 1e5) * 50;
  exp += n(save.s2PlayDays, 400) * 10;
  return exp;
}

function needFor(level) { return Math.floor(100 * Math.pow(level, 1.5)); }

function levelFromExp(exp) {
  let level = 1, rest = Math.max(0, Math.floor(exp || 0));
  while (rest >= needFor(level) && level < 9999) { rest -= needFor(level); level++; }
  return { level, into: rest, need: needFor(level) };
}

function jstMonth(t) {
  const d = new Date((t || Date.now()) + 9 * 3600 * 1000);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

module.exports = { LEVEL_KEY, SUBEXP_PREFIX, PLAN_MONTHLY_EXP, expFromSave, levelFromExp, needFor, jstMonth };
