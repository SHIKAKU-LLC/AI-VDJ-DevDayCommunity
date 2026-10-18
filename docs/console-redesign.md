# ブラウザ操作卓の刷新

## 画面と部品

本番の入口、参加、投稿、生成状況、再生画面を `room-web/console` のReact画面に集約する。audiocn-dsの実部品とStoneトークンを利用する。初期表示はダーク。明暗の選択はブラウザに記憶する。

M PLUS 2は本文、M PLUS 1 Codeは数値、DotGothic16はLCD、Phosphorはアイコンに使用。フォントはビルド時に同一オリジン用のファイルとして取り込み、Gitにフォント本体を含めない。出典と変更点は同ディレクトリの `THIRD_PARTY.md`、ライセンスは `LICENSE.*.txt` に記載する。

## 再生を保つ接続

`judge-controller.mjs` が通信、ルーム情報、生成、素材の取得を管理する。Reactは公開用状態を購読し、操作を渡す。従来のREST API、認証情報の保存先、音楽・映像の生成方針と枠は維持する。認証情報をReactの状態や再生診断に含めない。

AudioContext、動画要素、Canvasは画面の明暗やパネルの開閉で作り直さない。狭い画面の非表示パネルはキーボード操作の対象から外すが、再生処理は保持する。

音声経路は `連続再生 → 途切れの計測 → 出力GainNode → スピーカー`。VJは音量変更前、出力メーターは変更後の信号を参照する。音量は初期0 dB・上限0 dB・下端は無音。30msの変化でクリックを抑え、ミュートで曲の時計を止めない。

## ビルドと公開範囲

```bash
npm ci --prefix room-web/console
npm test --prefix room-web/console
npm run build --prefix room-web/console
python3 scripts/build_cloudflare_assets.py
npm run build:local --prefix cloud/cloudflare
```

Cloudflareのビルドも、画面用とWorker用の依存関係をそれぞれ `npm ci` で導入する。公開対象はコンパイル済みHTML・JavaScript・CSS・フォント、再生計測のWorklet、ライセンスだけ。ソースマップ、開発用API、旧Mac接続画面は公開しない。

## 再現可能な画面確認

`scripts/serve_console_fixture.mjs` はローカル専用の合成データサーバー。外部サービスやDBへ接続しない。`VDJ_FIXTURE_MEDIA` に合成の60秒ステレオWAV（tone.wav）、854×480・12秒のMP4（scene.mp4）を置いたディレクトリを指定する。素材はGitへ追加しない。

```bash
VDJ_FIXTURE_MEDIA=/path/to/synthetic node scripts/serve_console_fixture.mjs
```

`http://127.0.0.1:4176/room` で作成・文字投稿・任意画像の添付と解除・再生を確認できる。テスト専用の `/__fixture/mode?name=waiting` は生成待ち、`name=error` は再試行用の送信エラー、`name=ready` は完了を再現する。実際の生成課金は発生しない。

2026-10-18、390・768・1440・1920pxの明暗8通りで横はみ出し・再生操作と音量操作の重なりなし。操作卓の幅を基準に、狭い場合は音量を下段へ移す。文字投稿、画像添付と解除、送信中の重複防止、参加者画面、エラー時の入力保持、生成待ち、5曲上限の表示を確認。引き出しのEsc操作とフォーカス復帰、非表示パネルをキーボード対象から外す処理、動きを減らす設定も確認。合成素材の約153秒の再生で、曲・映像の切り替え、音量変更、ミュート、明暗、パネル移動、全画面を組み合わせ、映像の表示欠落0回、再生開始回数の変化なし。出力ミュート中は左右の実測値も無音になった。

検証用Workerでは配信と初期ダーク表示を確認。本番での保存済み素材の再生確認は、対象コミットのCI成功・マージ・配備後に別途記録する。今回の検証で新しい有料生成とDB更新は行わない。
