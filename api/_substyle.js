// =====================================================================
// 加入プランの「見た目」の選択肢と、どのプランから使えるか。
// index.html の SUB_STYLE_TIER と同じにしておくこと。
//
//   明治（2）… 名前の色・フォント・ネームプレートを各3種類、テーマ2種類
//   魁  （3）… 色8・フォント4・プレート4、テーマ3
//   超魁（4）… 各10種類、テーマ7
// 「ふつう」「なし」はいつでも選べる（数に入れない）。
// =====================================================================

const PLAN_LEVEL = { edo: 1, meiji: 2, sakigake: 3, cho: 4 };

const STYLE_TIER = {
  color: { default: 2, gold: 2, red: 2, blue: 2, green: 3, purple: 3, pink: 3, orange: 3, teal: 3, rainbow: 4, silver: 4 },
  font:  { default: 2, mincho: 2, dot: 2, yusei: 2, kurenaido: 3, dela: 4, hachimaru: 4, rampart: 4, reggae: 4, yuji: 4, train: 4 },
  plate: { none: 2, wood: 2, scroll: 2, lantern: 2, gold: 3, sakura: 4, wave: 4, night: 4, jade: 4, ruby: 4, rainbow: 4 },
  theme: { default: 2, sakura: 2, yuki: 2, kogane: 3, momiji: 4, umi: 4, yoru: 4, hanabi: 4 },
};
const DEFAULTS = { color: 'default', font: 'default', plate: 'none', theme: 'default' };

function planLevel(plan) { return PLAN_LEVEL[plan] || 0; }
function exists(key, val) { return !!(STYLE_TIER[key] && STYLE_TIER[key][val]); }
function allowed(key, val, level) { return exists(key, val) && level >= STYLE_TIER[key][val]; }

// 今のプランで使えない選択（プランを下げた人など）は「ふつう」に戻して返す。保存されている値は消さない。
function effectiveStyle(style, plan) {
  const lv = planLevel(plan), st = style || {}, out = {};
  for (const k of Object.keys(DEFAULTS)) out[k] = allowed(k, st[k], lv) ? st[k] : DEFAULTS[k];
  return out;
}

module.exports = { PLAN_LEVEL, STYLE_TIER, DEFAULTS, planLevel, exists, allowed, effectiveStyle };
