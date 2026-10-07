/* ============================================================
   手順2（画面表示版）：ランキング側の数値を確認し、結果を画面に出す

   コンソールの出力は Promise の表示より上に流れて見落としやすいので、
   このバージョンは結果をページ上の大きなテキスト欄に出します。
   欄の中身を全選択してコピーし、そのまま私に渡してください。

   【やり方】ゲームと同じドメインの非ゲームURL
            （例： https://（ドメイン）/api/get-ranking ）
            を開き、F12 → Console にこの中身を貼り付けて Enter。

   ※ゲームのページでは実行しないでください。
   ============================================================ */

(async function recover() {
  const API = location.origin + '/api';
  const myId = localStorage.getItem('kurofunePlayerId');
  const lines = [];
  const L = s => { lines.push(s); };

  L('===== 黒船クリッカー 復元調査 =====');
  L('playerId: ' + myId);
  L('実行時刻: ' + new Date().toLocaleString('ja-JP'));
  L('');

  // ---- 1) ランキング側の記録（セーブとは別キー）---------------------
  L('[1] ランキング側の記録 player:<id>');
  let rank = null;
  try {
    const r = await fetch(API + '/get-ranking').then(x => x.json());
    const rows = r.data || [];
    rank = rows.find(p => p.playerId === myId);
    if (rank) {
      L('  隻数         : ' + rank.clickerScore);
      L('  転生回数     : ' + rank.reincarnationCount);
      L('  開国のかけら : ' + rank.fragments);
      L('  時代         : ' + rank.era);
      L('  更新時刻     : ' + new Date(rank.updatedAt).toLocaleString('ja-JP'));
      L('  順位         : ' + (rows.indexOf(rank) + 1) + ' / ' + rows.length);
      L(Number(rank.clickerScore) > 1e14
        ? '  >>> 壊れる前の数値が残っています。これで復元できます。'
        : '  >>> ランキングも壊れた後の値です。施設から逆算して組み直します。');
    } else {
      L('  自分の行が上位100件にありません（ランキングから外れています）');
      L('  上位の顔ぶれ: ' + rows.slice(0, 5)
          .map(p => p.playerName + '=' + p.clickerScore).join(' / '));
    }
  } catch (e) { L('  取得失敗: ' + e.message); }
  L('');

  // ---- 2) クラウドのセーブ -----------------------------------------
  L('[2] クラウドのセーブ save:<id>');
  try {
    const res = await fetch(API + '/load-game?playerId=' + encodeURIComponent(myId));
    L('  HTTPステータス: ' + res.status);
    const r = await res.json();
    const cloud = r.data || null;
    if (cloud) {
      const fac = cloud.facilities || {};
      const owned = Object.entries(fac).filter(([, f]) => (Number(f.count) || 0) > 0)
        .map(([k, f]) => k + '×' + f.count).join(', ') || 'なし';
      const sk = Object.entries(cloud.skills || {}).filter(([, v]) => v).map(([k]) => k);
      const sp = Object.entries(cloud.superSkills || {}).filter(([, v]) => v).map(([k]) => k);
      L('  隻数         : ' + cloud.clickerScore);
      L('  転生 / 超転生: ' + cloud.reincarnationCount + ' / ' + cloud.superReincarnationCount);
      L('  かけら / 鎖国: ' + cloud.fragments + ' / ' + cloud.sakokuShards);
      L('  昇天スキル   : ' + (sk.length ? sk.join(',') : 'なし'));
      L('  超昇天スキル : ' + (sp.length ? sp.join(',') : 'なし'));
      L('  施設         : ' + owned);
      L('  保存時刻     : ' + new Date(cloud.lastSaveTime).toLocaleString('ja-JP'));
    } else {
      L('  セーブがありません（内容: ' + JSON.stringify(r).slice(0, 200) + '）');
    }
  } catch (e) { L('  取得失敗: ' + e.message); }
  L('');

  // ---- 3) 端末側の初期状態を退避して削除 ----------------------------
  L('[3] 端末側のセーブ localStorage');
  const local = localStorage.getItem('kurofuneSaveData');
  if (!local) {
    L('  ありません（すでに削除済み）');
  } else {
    let ls = null;
    try { ls = JSON.parse(local); } catch (e) {}
    const good = ls && (Number(ls.clickerScore) > 1e14 ||
                        Object.values(ls.skills || {}).some(Boolean));
    L('  隻数     : ' + (ls ? ls.clickerScore : '読めません'));
    L('  保存時刻 : ' + (ls ? new Date(ls.lastSaveTime).toLocaleString('ja-JP') : '-'));
    if (good) {
      L('  >>> 良いデータです。削除しませんでした。この中身を渡してください:');
      L('  ' + local);
    } else {
      const key = 'kurofuneSaveData_backup_' + Date.now();
      localStorage.setItem(key, local);
      localStorage.removeItem('kurofuneSaveData');
      L('  >>> 初期状態だったので ' + key + ' へ退避して削除しました。');
      L('      この後ゲームを開くと、クラウドの記録が読み込まれます。');
    }
  }
  L('');
  L('===== ここまで =====');

  const report = lines.join('\n');
  console.log(report);

  // 画面に大きく出す。コンソールを読まなくてもコピーできるように。
  try {
    const box = document.createElement('div');
    box.setAttribute('style',
      'position:fixed;inset:0;z-index:2147483647;background:#111;color:#eee;' +
      'padding:16px;box-sizing:border-box;font-family:monospace;');
    const ta = document.createElement('textarea');
    ta.value = report;
    ta.setAttribute('style',
      'width:100%;height:85%;background:#000;color:#0f0;border:1px solid #444;' +
      'font-family:monospace;font-size:13px;padding:10px;box-sizing:border-box;');
    const tip = document.createElement('div');
    tip.textContent = '▼ この枠の中を全選択（Ctrl+A）してコピー（Ctrl+C）し、そのまま渡してください';
    tip.setAttribute('style', 'margin-bottom:8px;font-weight:bold;color:#ffd700;');
    box.appendChild(tip);
    box.appendChild(ta);
    document.body.appendChild(box);
    ta.focus();
    ta.select();
  } catch (e) {
    console.log('画面表示に失敗しました。上のテキストをコピーしてください。');
  }
})();
