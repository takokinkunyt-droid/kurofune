#!/usr/bin/env node
// =====================================================================
// 公開用の index.html を作る。
//
//   読みやすい元のファイル … src/index.html   ← 直すのはこちら
//   公開されるファイル     … index.html       ← これは自動で作る（直接直さない）
//
// 使い方（リポジトリのいちばん上で）:
//   (cd scripts && npm install)   … 最初の1回だけ
//   node scripts/build.js
//
// やること
//   1. 実績の名前・説明・フレーバーテキストを暗号にする（ゲームは解除した実績だけ読み解いて出す）
//   2. <script> の中のプログラムを読みにくく変換する（文字・数字・名前を隠す）
//      広告の document.write を含む小さな <script> はそのまま
//   3. 隠したはずの言葉が残っていないか確かめる。残っていたら失敗にする
//
// ブラウザで動くゲームなので、本気で調べる人を完全に止めることはできない。
// 「Devツールでのぞいても、実績の条件がすぐには分からない」ことが目標。
// =====================================================================
const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require(path.join(__dirname, 'node_modules', 'javascript-obfuscator'));

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'index.html');
const OUT = path.join(ROOT, 'index.html');
// Classic（昔の版）も、合言葉や実績が書いてあるので同じように変換する。元は src/classic/ にある
const CLASSIC = ['perry_pc_app.html', 'code_artifact (1).html', 'AddUpdeatLog.html'];
const ACH_KEY = 'kurofune1853';            // src/index.html の ACH_KEY と同じにする

let html = fs.readFileSync(SRC, 'utf8');

// ---- 1. 実績の文章を暗号に ------------------------------------------
function enc(s) {
  const b = Buffer.from(s, 'utf8');
  for (let i = 0; i < b.length; i++) b[i] ^= ACH_KEY.charCodeAt(i % ACH_KEY.length);
  return '~' + b.toString('base64');
}
const start = html.indexOf('const achievementsData = {');
if (start < 0) throw new Error('achievementsData が見つからない');
const end = html.indexOf('\n    };', start);
if (end < 0) throw new Error('achievementsData の終わりが見つからない');
let block = html.slice(start, end);
const secrets = [];                         // 公開用に残ってはいけない言葉
let nEnc = 0;
block = block.replace(/\b(title|desc|flavor)\s*:\s*"((?:[^"\\]|\\.)*)"/g, (m, k, v) => {
  const text = JSON.parse('"' + v + '"');
  if (k !== 'flavor' && text.length >= 4) secrets.push(text);
  nEnc++;
  return k + ':"' + enc(text) + '"';
});
if (nEnc < 30) throw new Error('暗号にした実績の文章が少なすぎる（' + nEnc + '）');
html = html.slice(0, start) + block + html.slice(end);

// ---- 2. プログラムを読みにくく --------------------------------------
let blockNo = 0;
function obfuscateScripts(page) {
 let n = 0;
 page = page.replace(/<script>([\s\S]*?)<\/script>/g, (m, code) => {
  if (code.length < 3000 || code.includes('document.write')) return m;   // 広告の読み込みなどは触らない
  n++;
  const extra = process.env.OBF_EXTRA ? JSON.parse(process.env.OBF_EXTRA) : {};   // 設定を試すとき用
  const out = JavaScriptObfuscator.obfuscate(code, Object.assign({
    target: 'browser',
    compact: true,
    identifiersPrefix: 'k' + (++blockNo) + '_',   // 複数の <script> で名前がぶつからないように
    identifierNamesGenerator: 'hexadecimal',
    renameGlobals: false,                   // onclick="..." から呼ぶ関数の名前は変えない
    stringArray: true,
    stringArrayThreshold: 1,
    stringArrayEncoding: ['base64'],
    stringArrayWrappersCount: 0,            // 包み関数を増やすと、連打のたびの読み解きが重くなる（約4倍）
    stringArrayRotate: true,
    stringArrayShuffle: true,
    transformObjectKeys: true,
    numbersToExpressions: true,
    simplify: true,
    splitStrings: false,                    // 重くなるので使わない
    controlFlowFlattening: false,           // 同上（連打が重くなる）
    deadCodeInjection: false,
    selfDefending: false,
    debugProtection: false,
    unicodeEscapeSequence: false,
    sourceMap: false,
  }, extra)).getObfuscatedCode();
  return '<script>' + out + '</script>';
 });
 if (n < 1) throw new Error('変換した <script> がない');
 return { page, n };
}
const main = obfuscateScripts(html);
html = main.page;
const n = main.n;

// ---- 3. 確かめる ----------------------------------------------------
const mustHide = ['ペリーカツラハゲ', 'TheBlackboatandship00981', 'RENDA KING', 'クリック中毒改善センター', 'combo10000', 'treeSuifu', ...secrets];
// 画面の HTML（<script> の外）に元からある言葉（イベントの名前など）は、実績から漏れたわけではないので除く
const srcMarkup = fs.readFileSync(SRC, 'utf8').replace(/<script>[\s\S]*?<\/script>/g, '');
const leaked = [...new Set(mustHide)].filter(w => html.includes(w) && !srcMarkup.includes(w));
if (leaked.length) {
  console.error('公開用に残ってはいけない言葉が残っています:', leaked.slice(0, 10));
  process.exit(1);
}

fs.writeFileSync(OUT, html);

// ---- Classic ----------------------------------------------------------
for (const name of CLASSIC) {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'classic', name), 'utf8');
  const r = obfuscateScripts(src);
  const left = ['ペリーカツラハゲ', 'TheBlackboatandship00981'].filter(w => r.page.includes(w));
  if (left.length) { console.error(name + ' に合言葉が残っています:', left); process.exit(1); }
  fs.writeFileSync(path.join(ROOT, name), r.page);
}
console.log('index.html を作りました：実績の文章 ' + nEnc + ' か所を暗号に、<script> ' + n + ' 個を変換（' +
            Math.round(fs.statSync(SRC).size / 1024) + 'KB → ' + Math.round(html.length / 1024) + 'KB）、Classic ' + CLASSIC.length + ' 個も変換');
