// =====================================================================
// 黒船クリッカー セーブ消失の調査スクリプト
//
// 使い方：黒船クリッカーのページを開き、F12 → Console タブに
//        このファイルの中身を全部貼り付けて Enter。
//
// 何も書き換えません。読むだけです。
// =====================================================================

(async function diagnose() {
  const API = location.origin + '/api';
  const myId = localStorage.getItem('kurofunePlayerId');

  const line = (s) => console.log('%c' + s, 'font-family:monospace');
  const head = (s) => console.log('%c\n' + s, 'font-weight:bold;font-size:13px');

  head('■ プレイヤーID');
  line('  ' + myId);

  // ---- 1) ランキング記録（player:<id>）------------------------------
  // これはセーブとは別のキーに入っている。セーブが壊れても、
  // ランキング側には壊れる前の隻数・転生回数・かけら・時代が残っている可能性が高い。
  head('■ ランキング側の記録（セーブとは別キー。壊れる前の値が残っていることがある）');
  let rankRow = null;
  try {
    const r = await fetch(API + '/get-ranking').then(x => x.json());
    const rows = r.data || [];
    rankRow = rows.find(p => p.playerId === myId);
    if (rankRow) {
      line('  プレイヤー名   : ' + rankRow.playerName);
      line('  隻数           : ' + rankRow.clickerScore);
      line('  転生回数       : ' + rankRow.reincarnationCount);
      line('  開国のかけら   : ' + rankRow.fragments);
      line('  時代           : ' + rankRow.era);
      line('  最終更新       : ' + new Date(rankRow.updatedAt).toLocaleString('ja-JP')
            + '  (' + rankRow.updatedAt + ')');
      line('  順位           : ' + (rows.indexOf(rankRow) + 1) + ' / ' + rows.length);
    } else {
      line('  ランキング上位100件に自分の行が見つかりませんでした。');
    }
  } catch (e) {
    line('  取得失敗: ' + e.message);
  }

  // ---- 2) クラウドのセーブ -----------------------------------------
  head('■ クラウドのセーブ（save:<id>）');
  let cloud = null;
  try {
    const r = await fetch(API + '/load-game?playerId=' + encodeURIComponent(myId)).then(x => x.json());
    cloud = r.data || null;
    if (cloud) summarize(cloud);
    else line('  セーブなし');
  } catch (e) {
    line('  取得失敗: ' + e.message);
  }

  // ---- 3) ブラウザのセーブ -----------------------------------------
  head('■ このブラウザのセーブ（localStorage）');
  let local = null;
  try {
    local = JSON.parse(localStorage.getItem('kurofuneSaveData') || 'null');
    if (local) summarize(local);
    else line('  セーブなし（localStorage が空）');
  } catch (e) {
    line('  読めません: ' + e.message);
  }

  // ---- 4) 突き合わせ -----------------------------------------------
  head('■ 判定');
  if (rankRow && cloud) {
    const rs = Number(rankRow.clickerScore) || 0;
    const cs = Number(cloud.clickerScore) || 0;
    line('  ランキングの隻数 : ' + rs);
    line('  セーブの隻数     : ' + cs);
    if (rs > cs * 100) {
      line('  → ランキング側に壊れる前の値が残っています。これを使って復元できます。');
      line('     ランキング更新時刻: ' + new Date(rankRow.updatedAt).toLocaleString('ja-JP'));
      line('     セーブ保存時刻    : ' + new Date(cloud.lastSaveTime).toLocaleString('ja-JP'));
      if (rankRow.updatedAt > cloud.lastSaveTime) {
        line('     ※ランキングの方が新しい＝セーブだけが古い状態で止まっている');
      } else {
        line('     ※セーブの方が新しい＝壊れたセーブが後から上書きされた');
      }
    } else {
      line('  → ランキング側も同じ値。壊れた状態でランキングも更新済み。');
    }
  }

  if (cloud && local) {
    line('  クラウド最終保存 : ' + new Date(cloud.lastSaveTime).toLocaleString('ja-JP'));
    line('  ローカル最終保存 : ' + new Date(local.lastSaveTime).toLocaleString('ja-JP'));
    line('  次回起動時に採用されるのは: '
      + ((cloud.lastSaveTime || 0) > (local.lastSaveTime || 0) ? 'クラウド' : 'ローカル'));
  }

  // ---- 5) 履歴（新しい save-game.js を入れてからのみ存在）-----------
  head('■ セーブ履歴（新しい save-game.js を入れた後に溜まり始めます）');
  try {
    const r = await fetch(API + '/restore-save?playerId=' + encodeURIComponent(myId) + '&action=list')
      .then(x => x.json());
    if (r.history && r.history.length) {
      r.history.forEach((h, i) => {
        line('  [' + i + '] ' + new Date(h.lastSaveTime).toLocaleString('ja-JP')
          + '  隻数=' + h.clickerScore
          + '  転生=' + h.reincarnationCount
          + '  スキル=' + h.skillCount
          + '  施設=' + h.facilityCount);
      });
      line('  → 戻したい番号を決めたら restore-save で復元できます。');
    } else {
      line('  履歴なし（まだ新しい save-game.js が入っていません）');
    }
  } catch (e) {
    line('  履歴APIがありません（未デプロイ）');
  }

  function summarize(s) {
    const fac = s.facilities || {};
    const facCount = Object.values(fac).reduce((a, f) => a + (Number(f && f.count) || 0), 0);
    const owned = Object.entries(fac).filter(([, f]) => (Number(f.count) || 0) > 0)
      .map(([k, f]) => k + '×' + f.count).join(', ') || 'なし';
    const skills = Object.entries(s.skills || {}).filter(([, v]) => v).map(([k]) => k);
    const supers = Object.entries(s.superSkills || {}).filter(([, v]) => v).map(([k]) => k);
    const ach = Object.values(s.achievements || {}).filter(v => v && v.unlocked).length;
    line('  saveVersion    : ' + s.saveVersion);
    line('  隻数           : ' + s.clickerScore);
    line('  今回の累計     : ' + s.currentLifeScore);
    line('  転生 / 超転生  : ' + s.reincarnationCount + ' / ' + s.superReincarnationCount);
    line('  かけら / 鎖国  : ' + s.fragments + ' / ' + s.sakokuShards);
    line('  時代           : ' + s.currentEra);
    line('  昇天スキル     : ' + (skills.length ? skills.join(', ') : '（全部なし）'));
    line('  超昇天スキル   : ' + (supers.length ? supers.join(', ') : '（全部なし）'));
    line('  施設合計       : ' + facCount + ' 棟  [' + owned + ']');
    line('  実績解除       : ' + ach + ' 個');
    line('  最終保存       : ' + new Date(s.lastSaveTime).toLocaleString('ja-JP')
          + '  (' + s.lastSaveTime + ')');
  }
})();
