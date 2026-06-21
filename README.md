# kurofune
黒船クリッカー - ペリー来航メガパニック

## デプロイ方法（Vercel）

1. このリポジトリ（`index.html` と `api/` フォルダ一式）をVercelにインポートします。
2. Vercelのプロジェクト設定 → **Environment Variables** で以下を設定してください（Upstash Redisのダッシュボードから取得できます）。
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
3. デプロイすると、`/api/save-game` `/api/load-game` `/api/update-ranking` `/api/get-ranking` `/api/delete-save` が自動的にサーバーレス関数として有効になります（`api/` フォルダ内の `.js` ファイルがそのままエンドポイントになります）。
4. ビルドコマンドは不要です（静的サイト + サーバーレス関数構成）。

## フォルダ構成

```
index.html      ... ゲーム本体
api/
  save-game.js       ... セーブデータ保存
  load-game.js       ... セーブデータ読込
  update-ranking.js  ... ランキング更新
  get-ranking.js     ... ランキング取得
  delete-save.js     ... セーブデータ削除
```

※以前のNetlify版（`netlify/functions` + `netlify.toml`）からの移行版です。バックエンドのロジック（Upstash Redis REST API呼び出し）は変更していません。
