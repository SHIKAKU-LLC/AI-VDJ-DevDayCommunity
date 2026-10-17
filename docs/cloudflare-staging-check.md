# Cloudflare検証環境の確認記録

確認日: 2026-10-18（日本時間）

検証用Worker `ai-vdj-devdaycommunity-staging` と、最大1台のContainer
`ai-vdj-devdaycommunity-staging-native` を作成した。本番の切替、既存DBの書換え、生成サービスの呼出しは行っていない。

## 確認できたこと

- `de1eab1` をCloudflare Workers Buildsで取得・組み立て・配備した。Air上のDockerは使用していない。
- [検証用画面](https://ai-vdj-devdaycommunity-staging.hapx2yuki.workers.dev/room) をブラウザで表示できた。
- `/api/room-capabilities` は `serverManaged: true`、`macRequired: false`、`generation: false` を返した。
- CloudflareのContainer内で24秒の固定合成WAVを作成し、既存のPython・ffmpeg検査を実行した。
- 実測結果は `passed`、1,058,400フレーム、44,100Hz、2チャンネルだった。
- 同じ確認要求の再送は保存済みの結果を返した。他オリジンからの実行要求は403で拒否した。
- D1のイベント・ルーム・費用予約・実行記録は、検証後もすべて0件。R2の公開アクセスは無効。
- 対象コードのGitHub CIは3ジョブすべて成功した。

確認に使用したContainerイメージのSHA-256:

```text
8e80819a0013aef46c3cbcf4c56f2b286029a5b7307631f613a8a027f6a3b966
```

このイメージ内の検査プログラムは `de1eab1` と同一である。
Workerの更新とイメージの切替は同時ではない。初回の確認用インスタンスには古いイメージが割り当てられたため、
イメージの更新を確認し、新しい専用インスタンスで確認した。失敗した要求の自動再実行は行わない。

## まだ確認していないこと

- 初期音源・参照画像の生成、参加者の入力からの音楽・映像生成。
- 生成物のR2保存と、音声・映像の組合せからブラウザへの受渡し。
- 大画面での実再生、Cueの切替、途切れない連続再生。
- 審査員の別端末による一連の操作。

検証用画面は生成準備中と表示する。合成音声の検査成功を、上記の機能の完成とは扱わない。
本番用Workerの初期ビルド設定は別途移行が必要で、今回の検証環境とは分けて扱う。
