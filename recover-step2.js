/* ============================================================
   手順2：10/06のクラウド記録を呼び戻し、ランキング側の数値を確認する

   いまブラウザ側のセーブは 10/07 22:21 の初期状態（1隻）で、
   クラウドの 10/06 20:58 の記録より「新しい」と判定されます。
   そのままだと再読み込みしても1隻の方が採用されてしまうので、
   ブラウザ側の初期状態を先に捨てる必要があります。

   【やり方】ゲームと同じドメインの非ゲームURL
            （例： https://（ドメイン）/api/get-ranking ）
            を開き、F12 → Console にこの中身を貼り付けて Enter。

   ※ゲームのページでは実行しないでください。
   ============================================================ */

(async function recover() {
  const API = location.origin + '/api';
  const myId = localStorage.getItem('kurofunePlayerId');
  const L = s => console.log('%c' + s, 'font-family:monospace');

  console.log('■ プレイヤーID:', myId);

  // ---- 1) ランキング側の記録を読む（復元の手掛かり）-----------------
  // ランキングは player:<id> という別キー。update-ranking は
  // 保存が成功した直後にしか呼ばれないので、ここに壊れる前の
  // 数値が残っていれば、それが本当の到達値になる。
  console.log('\n■ ランキング側の記録');
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
      if (Number(rank.clickerScore) > 1e14) {
        console.log('%c  ★ 壊れる前の数値が残っています。これで復元できます。',
                    'color:#27ae60;font-weight:bold;font-size:14px');
      } else {
        console.log('%c  △ ランキングも壊れた後の値です。施設からの逆算で組み直します。',
                    'color:#e67e22;font-weight:bold');
      }
    } else {
      L('  自分の行が上位100件に見つかりません（ランキングから外れています）');
    }
  } catch (e) { L('  取得失敗: ' + e.message); }

  // ---- 2) クラウドのセーブを確認 -----------------------------------
  console.log('\n■ クラウドのセーブ');
  let cloud = null;
  try {
    const r = await fetch(API + '/load-game?playerId=' + encodeURIComponent(myId)).then(x => x.json());
    cloud = r.data || null;
    if (cloud) {
      const fac = cloud.facilities || {};
      const owned = Object.entries(fac).filter(([, f]) => (Number(f.count) || 0) > 0)
        .map(([k, f]) => k + '×' + f.count).join(', ') || 'なし';
      L('  隻数     : ' + cloud.clickerScore);
      L('  施設     : ' + owned);
      L('  保存時刻 : ' + new Date(cloud.lastSaveTime).toLocaleString('ja-JP'));
    } else {
      L('  セーブがありません');
    }
  } catch (e) { L('  取得失敗: ' + e.message); }

  // ---- 3) ブラウザ側の初期状態を捨てる -----------------------------
  // これをやらないと、1隻の方が新しいので再読み込みしても戻らない。
  console.log('\n■ ブラウザ側のセーブを退避して削除');
  const local = localStorage.getItem('kurofuneSaveData');
  if (local) {
    let ls = null;
    try { ls = JSON.parse(local); } catch (e) {}
    if (ls && (Number(ls.clickerScore) > 1e14 ||
               Object.values(ls.skills || {}).some(Boolean))) {
      console.log('%c  中止：ブラウザ側に良いデータが入っています。削除しません。',
                  'color:#c0392b;font-weight:bold');
      console.log('  この JSON を渡してください → ' + local);
      return;
    }
    // 念のため別キーへ退避してから消す
    localStorage.setItem('kurofuneSaveData_backup_' + Date.now(), local);
    localStorage.removeItem('kurofuneSaveData');
    L('  削除しました（kurofuneSaveData_backup_* に退避済み）');
  } else {
    L('  すでにありません');
  }

  console.log('%c\n— 完了 —', 'font-weight:bold');
  console.log('この後ゲームを開くと、クラウドの 10/06 20:58 の記録が読み込まれます。');
  console.log('（施設95/95/38は戻りますが、スキルと転生回数は入っていません）');
  console.log('上の「ランキング側の記録」の内容を私に伝えてください。それで最終的に組み直します。');
})();
