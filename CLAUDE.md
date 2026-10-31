# 黒船クリッカー：作業のきまり

- **直すのは `src/index.html`**。ルートの `index.html` は公開用に自動で作るファイルなので、直接直さない。
  直したら必ず `node scripts/build.js` を実行して `index.html` を作り直し、両方をコミットする。
  （初めての環境では先に `cd scripts && npm install`）
- build.js は、実績の名前・説明・フレーバーテキストを暗号にし、<script> を読みにくく変換する。
  隠したはずの言葉が残っていると失敗するので、そのときは原因を直す。
- 黒船の名前の合言葉（ペリー系・Classic）は、文字ではなくハッシュ（nameHash）で比べている。新しい合言葉もハッシュで書く。
- **アップデートログ（changelogData）に実績の中身（名前・条件・フレーバーテキスト）を書かない。**「実績を追加しました」程度にする。
- 新しい実績で珍しい（特殊）ものは、src/index.html の LEVEL_RARE_ACH と api/_level.js の RARE_ACH の両方に足す。
- `.vercelignore` に書いたファイル（src・scripts・docs・開発用の復旧ファイル）はサイトとして配らない。
