# セーブ復元の手順（管理者用）

消えたセーブを `api/restore-save.js` 経由で戻します。
このエンドポイントは `ADMIN_SECRET` を知っている人だけが使えます。

> ## ⚠️ 貼り付ける場所に注意
>
> この手順のコマンドは **ターミナル** 用です。
>
> - Windows → **PowerShell**（スタートメニューで「PowerShell」と検索）
> - Mac → **ターミナル**（Launchpad →「ターミナル」）
>
> **ブラウザの F12 コンソールに貼ると `Uncaught SyntaxError` になります。**
> あれは JavaScript しか動きません。

---

## 1. Vercel に ADMIN_SECRET を設定する

1. Vercel のプロジェクト → **Settings** → **Environment Variables**
2. 以下を追加

   | Key | Value |
   |---|---|
   | `ADMIN_SECRET` | 自分で決めた長い文字列（他人に教えない） |

3. **Deployments** → 最新のものを **Redeploy**
   （環境変数は再デプロイしないと反映されません）

`admin-ban.js` も同じ鍵を使うので、設定は1つで足ります。

---

## 2. restore-payload.json を置く

ダウンロードした `restore-payload.json` の場所でターミナルを開きます。
ふつうはダウンロードフォルダです。

**Windows (PowerShell)**
```powershell
cd ~\Downloads
```

**Mac**
```sh
cd ~/Downloads
```

---

## 3. 復元を実行する

### Windows (PowerShell)

`ここにADMIN_SECRET` と `ここにドメイン` の2か所を書き換えてから、
**全部まとめて** PowerShell に貼り付けてください。

```powershell
$secret = 'ここにADMIN_SECRET'
$domain = 'https://ここにドメイン'

# payload の先頭に secret を差し込む（JSONを作り直さないので壊れません）
$raw  = Get-Content -Raw -Encoding UTF8 .\restore-payload.json
$body = '{"secret":"' + $secret + '",' + $raw.Substring(1)
$bytes = [System.Text.Encoding]::UTF8.GetBytes($body)

Invoke-RestMethod -Uri "$domain/api/restore-save" -Method Post `
  -ContentType 'application/json' -Body $bytes
```

### Mac / Linux

```sh
SECRET='ここにADMIN_SECRET'
DOMAIN='https://ここにドメイン'

# payload の先頭に secret を差し込む
{ printf '{"secret":"%s",' "$SECRET"; tail -c +2 restore-payload.json; } > req.json

curl -X POST "$DOMAIN/api/restore-save" \
  -H 'Content-Type: application/json' \
  --data-binary @req.json

rm req.json
```

### 成功した時の返り

```json
{"success":true,"restored":{"clickerScore":1.4e17,"reincarnationCount":40,
 "fragments":2000,"sakokuShards":36000,"currentEra":"edo",
 "skillCount":25,"facilityCount":231}}
```

`skillCount: 25` は 昇天15 + 超昇天10 の合計です。

### うまくいかない時

| 返り | 原因 |
|---|---|
| `{"error":"Forbidden"}` | `ADMIN_SECRET` が違う、または再デプロイしていない |
| `{"error":"Missing playerId"}` | payload の差し込みが失敗している。`$body` の先頭が `{"secret":"...","playerId":"player_...` になっているか確認 |
| 404 | ドメインが違う、または `api/restore-save.js` がまだデプロイされていない |
| `Invalid JSON body` | ファイルの文字コードが UTF-8 以外になっている |

---

## 4. 確認する

1. ゲームのページを開いて再読み込み
2. 隻数・転生回数・かけら・昇天ツリーが戻っているか確認
3. ランキングにも反映されます（並び順と表示用の記録の両方を更新します）

---

## 書き戻す内容

| 項目 | 値 | 根拠 |
|---|---|---|
| 隻数 | 1.4京（1.4e17） | 施設の累計支出13.7京＋手持ち分 |
| 昇天スキル | 全15個 | タイムマシーン所持＝時間操作＝Ifが前提 |
| 超昇天スキル | 全10個 | 東京駅・鉄道＝明治維新、タイムマシーン＝時間操作 |
| 開国のかけら | 2,000 | 推定 |
| 鎖国のかけら | 36,000 | 推定（時間操作 35,000 を払える額） |
| 転生 / 超転生 | 40 / 5 | 推定。実際の値は記録が残っていない |
| 条約 | 両方締結済み | 「開国」実績が解除済み |
| 施設・実績 | **変更なし** | 無傷だったので触らない |

---

## やり直したい場合

`restore-save.js` は書き込む前に、いま入っているデータも履歴へ積みます。

**履歴の一覧**（要約だけなので鍵は不要。ブラウザのアドレスバーに直接入れてもOK）
```
https://ここにドメイン/api/restore-save?playerId=player_mqn98q4c_ja51ya9s&action=list
```

**番号を指定して戻す（PowerShell）**
```powershell
$secret = 'ここにADMIN_SECRET'
$domain = 'https://ここにドメイン'
Invoke-RestMethod -Uri "$domain/api/restore-save" -Method Post `
  -ContentType 'application/json' `
  -Body "{""secret"":""$secret"",""playerId"":""player_mqn98q4c_ja51ya9s"",""index"":0}"
```

**番号を指定して戻す（Mac / Linux）**
```sh
curl -X POST "$DOMAIN/api/restore-save" -H 'Content-Type: application/json' \
  -d "{\"secret\":\"$SECRET\",\"playerId\":\"player_mqn98q4c_ja51ya9s\",\"index\":0}"
```

---

## 他の人のデータが消えた時

これ以降は `save-game.js` が上書きの前に20世代分のバックアップを残します。
消えた人が出たら、上の「履歴の一覧」を開いて壊れる前の番号を見つけ、
`index` 指定で戻すだけです。payload を手で組む必要はありません。
