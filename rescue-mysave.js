/* ============================================================
   手順1：ブラウザに残っている可能性のあるセーブを救出する

   ★★★ 先に読んでください ★★★

   ゲームのページを普通に開いてはいけません。
   開くとクラウドの壊れたデータ（10/06 20:58）の方が新しいので、
   そちらが採用され、ブラウザに残っている良いデータが
   その場で上書きされて消えます。

   【やり方】黒船クリッカーを遊んでいた端末・ブラウザで、

     1. ゲームのタブが開いていたら、まず閉じる
     2. アドレスバーに、ゲームと同じドメインの
        「ゲーム本体ではないURL」を入れて開く。たとえば

            https://（あなたのゲームのドメイン）/api/get-ranking

        JSONが表示されるだけで、ゲームのコードは動きません。
        同じドメインなので localStorage は読めます。
     3. そのページで F12 → Console
     4. このファイルの中身を貼り付けて Enter
     5. 出てきた JSON を全部コピーして私に渡してください
   ============================================================ */

(function rescue() {
  const out = {};
  const keys = ['kurofuneSaveData', 'kurofunePlayerId', 'kurofunePlayerName',
                'kurofuneSaveToken', 'kurofuneSettings', 'kurofunePanState'];
  keys.forEach(k => { out[k] = localStorage.getItem(k); });

  console.log('===== localStorage の中身 =====');
  if (!out.kurofuneSaveData) {
    console.log('%c✗ kurofuneSaveData がありません。この端末には残っていません。',
                'color:#c0392b;font-weight:bold');
  } else {
    let s = null;
    try { s = JSON.parse(out.kurofuneSaveData); } catch (e) {
      console.log('✗ 壊れていて読めません:', e.message);
    }
    if (s) {
      const fac = s.facilities || {};
      const facTotal = Object.values(fac).reduce((a, f) => a + (Number(f && f.count) || 0), 0);
      const skills = Object.entries(s.skills || {}).filter(([, v]) => v).map(([k]) => k);
      const supers = Object.entries(s.superSkills || {}).filter(([, v]) => v).map(([k]) => k);
      console.log('保存時刻     :', new Date(s.lastSaveTime).toLocaleString('ja-JP'));
      console.log('隻数         :', s.clickerScore);
      console.log('転生 / 超転生:', s.reincarnationCount, '/', s.superReincarnationCount);
      console.log('かけら / 鎖国:', s.fragments, '/', s.sakokuShards);
      console.log('時代         :', s.currentEra);
      console.log('昇天スキル   :', skills.length ? skills.join(', ') : '（なし）');
      console.log('超昇天スキル :', supers.length ? supers.join(', ') : '（なし）');
      console.log('施設合計     :', facTotal, '棟');

      const broken = (new Date(s.lastSaveTime).getTime() <= 1791287886501) && skills.length === 0;
      if (skills.length > 0 || Number(s.clickerScore) > 1e14) {
        console.log('%c\n★ 良いデータが残っています。下の JSON を全部コピーして渡してください。',
                    'color:#27ae60;font-weight:bold;font-size:14px');
      } else {
        console.log('%c\n△ こちらも壊れた後の状態のようです。手順2へ進みます。',
                    'color:#e67e22;font-weight:bold');
      }
    }
  }

  // 丸ごとコピーできる形で出す
  const dump = JSON.stringify(out);
  console.log('===== ここから下を全部コピー =====');
  console.log(dump);
  try {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(dump)
        .then(() => console.log('%c（クリップボードにもコピーしました）', 'color:#2980b9'))
        .catch(() => {});
    }
  } catch (e) {}
  return dump;
})();
