# セーブ復元の手順（管理者用）

消えたセーブを `api/restore-save.js` 経由で戻す手順です。
このエンドポイントは `ADMIN_SECRET` を知っている人だけが使えます。

## 1. Vercel に ADMIN_SECRET を設定する

1. Vercel のプロジェクト → **Settings** → **Environment Variables**
2. 以下を追加

   | Key | Value |
   |---|---|
   | `ADMIN_SECRET` | 自分で決めた長い文字列（他人に教えない） |

3. **Deployments** から最新のデプロイを **Redeploy**
   （環境変数は再デプロイしないと反映されません）

`admin-ban.js` も同じ `ADMIN_SECRET` を使うので、設定は1つで足ります。

## 2. 復元を実行する

`restore-payload.json` が書き戻す内容です。
中身は 10/06 の記録を土台に、失われた項目だけを戻したものです。
施設の個数・強化レベル・実績は**一切変更していません**。

ターミナルから実行する場合：

```sh
# SECRET と DOMAIN を自分のものに置き換える
SECRET='ここにADMIN_SECRET'
DOMAIN='https://ここにゲームのドメイン'

# payload に secret を足して送る
python3 - "$SECRET" <<'PY' > /tmp/req.json
import json,sys
d=json.load(open('restore-payload.json'))
d['secret']=sys.argv[1]
json.dump(d,open('/tmp/req.json','w'),ensure_ascii=False)
PY

curl -X POST "$DOMAIN/api/restore-save" \
  -H 'Content-Type: application/json' \
  --data-binary @/tmp/req.json
```

成功すると、戻した内容が返ってきます。

```json
{"success":true,"restored":{"clickerScore":1.4e17,"reincarnationCount":40,
 "fragments":2000,"sakokuShards":36000,"skillCount":25,"facilityCount":231}}
```

## 3. 確認する

1. ゲームのページを開いて再読み込み
2. 隻数・転生回数・かけら・昇天ツリーが戻っているか確認
3. ランキングにも反映されます（並び順と表示用の記録の両方を更新します）

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
| 施設・実績 | 変更なし | 無傷だったので触らない |

## 元に戻したい場合

`restore-save.js` は書き込む前に、いま入っているデータも履歴へ積みます。
やり直したい時は履歴の一覧を見て、番号を指定して戻せます。

```sh
# 履歴の一覧（要約だけなので secret 不要）
curl "$DOMAIN/api/restore-save?playerId=player_mqn98q4c_ja51ya9s&action=list"

# 番号を指定して戻す
curl -X POST "$DOMAIN/api/restore-save" \
  -H 'Content-Type: application/json' \
  -d "{\"secret\":\"$SECRET\",\"playerId\":\"player_mqn98q4c_ja51ya9s\",\"index\":0}"
```

## 他の人のデータが消えた時

これ以降は `save-game.js` が上書きの前に20世代分のバックアップを残します。
消えた人が出たら、履歴の一覧を見て、壊れる前の番号を指定するだけで戻せます。
payload を手で組む必要はありません。
