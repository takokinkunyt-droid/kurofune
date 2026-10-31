# 幕末大乱闘の対戦サーバー

Cloudflare Workers + Durable Objects で動く、リアルタイム対戦のサーバー。
サイト（Vercel）とは別に、Cloudflare に置く。`.vercelignore` で Vercel には配らないようにしてある。

- `src/sim.js` … 試合の中身（動き・当たり・蹴鞠・一揆・CPU）。サーバーが正本
- `src/worker.js` … つなぐ口と、順番待ち・部屋の管理（Hub という Durable Object ひとつ）

## 手元で試す

```
cd game
npm install
npx wrangler dev --port 8787
```

サイトを `?ranto=ws://127.0.0.1:8787/ws` 付きで開くと、手元のサーバーにつながる。

## Cloudflare に置く（最初の1回）

1. Cloudflare のダッシュボード → Workers & Pages → 作成 → 「Git リポジトリをインポート」
2. GitHub をつなぎ、このリポジトリを選ぶ
3. 「ルートディレクトリ（Root directory）」を `game` にする。ほかはそのまま
4. デプロイ。できたら `https://kurofune.〇〇.workers.dev` という住所が出る
5. `src/index.html` の `RANTO_SERVER` に `wss://kurofune.〇〇.workers.dev/ws` を書いて、ビルドしてコミット

以後は main に push するたび、Cloudflare も自動で作り直される。

## お金

無料プランの範囲で動く（Durable Objects は SQLite 型）。無料の上限を超えたら、その日は
つながらなくなるだけで、勝手に請求はされない。
