# Cloudflareへの移行

現在は、Workersによる画面配信とD1によるルーム作成・参加・投稿・受付切替まで接続している。
音楽・映像の生成、Containersの処理、連続再生は未接続で、本番へは配備していない。
R2の単一素材を生成サービスへ渡す期間限定の取得処理は実装・単体検証済みで、生成処理からの呼出しは未接続。
受付画面は生成準備中であることを表示し、生成・演奏ボタンを有効にしない。

## 本番の組み立てと実行

本番はCloudflareのWorkers BuildsでGitHubから取得・ビルドし、Workers・D1・R2・Containersで実行する方針。
Air、Macの常駐プログラム、利用者のDockerには依存しない。利用者・審査員・オーナーはブラウザだけで接続する。
以下のローカル起動は開発時の任意の確認方法であり、本番の動作条件ではない。

Workers Buildsの設定案（未接続・未配備）:

| 項目 | 設定案 |
| --- | --- |
| GitHub | `SHIKAKU-LLC/AI-VDJ-DevDayCommunity` のみ |
| ルート | リポジトリのルート |
| Node.js | `NODE_VERSION=24.22.0` |
| ビルド | `npm ci --prefix cloud/cloudflare && npm run build --prefix cloud/cloudflare` |
| 配備 | `cd cloud/cloudflare && npx cf deploy --prebuilt --mode production` |
| 本番ブランチ | `main`。接続開始と公開は別途承認後 |

ContainersのDockerfileもWorkers Builds内で組み立てる。Containersは独立した検証用Workerで動作確認してから本番へ接続する。
ビルド用のGitHub連携・Cloudflare権限は対象を確認して設定する。生成用の秘密値はビルド変数に入れず、実行時のSecretとして別に設定する。
参考: [Containersの配備](https://developers.cloudflare.com/containers/guides/deploy/)、[Workers Buildsの設定](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)。

`Dockerfile` と `native-service.mjs` は、既存のPython・ffmpeg検査をContainersから呼ぶための準備。
通信はサーバー間の認証を必須とし、入力ファイルの上限とハッシュを確認する。同時処理は1件。
任意のURL、ファイルパス、コマンド、利用者による検査結果の指定は受け付けない。
現時点では検査用HTTP処理と実際のPython検査をローカルで確認済み。Cloudflareでのイメージビルド・起動は未検証。

## ローカルで起動する

Node.js 24とPython 3を使用する。リポジトリのルートで実行する。

```sh
npm ci --prefix cloud/cloudflare
npm run build:local --prefix cloud/cloudflare
npm run dev --prefix cloud/cloudflare
```

画面は `http://localhost:8787/room`。開発用D1には別途 `schema.sql` とテスト用イベントが必要。
データが未作成の場合、ルーム作成は失敗する。ローカルのD1だけを初期化し、本番へSQLを送らないこと。

画面ファイルは `scripts/build_cloudflare_assets.py` の許可リストから生成する。
Mac接続ページ・ローカル接続用の通信許可・リポジトリ内の設定ファイルは配信対象に含めない。
出力先 `.cloudflare/` はGit管理しない。

## 本番用の設定

`cloudflare.config.ts` を `cf` で使用する。次の値が不足する本番ビルドは停止する。

| 環境変数 | 内容 |
| --- | --- |
| `VDJ_PUBLIC_ORIGIN` | 承認済みの公開先。HTTPSのオリジンのみ |
| `VDJ_D1_ID` | 専用D1のUUID |
| `VDJ_EVENT_ID` | 公開期間・人数・予算を管理するイベントID |

この3項目は接続先の識別情報であり、APIキーを入れない。
生成サービスの秘密値は、今後サーバー側のSecretとして接続する。画面用ファイルやD1のルーム文書には保存しない。
利用者にAPIキーの入力やMacへの接続は求めない。

Workerは同一オリジンのAPIだけを受付し、ルームの権限は個別のランダム値で確認する。
D1には権限のハッシュを保存し、公開レスポンスから内部の操作記録を除く。
期限・受付上限・更新の競合はD1の条件付きSQLで確認する。

## 残っている作業

1. 作成済みの専用D1 `ai-vdj-room` と非公開R2 `ai-vdj-media` を実行処理へ接続する。D1は空テーブル4件のみで、受付イベントは未作成。R2の公開アクセスは無効。
2. 初期音源・参照画像の生成と、実装済みのR2素材受渡し処理を接続する。
3. ContainersへPython・ffmpegの処理を移し、D1に生成の実行履歴と費用を永続化する。
4. 生成音楽・映像を既存のブラウザ再生処理へ接続し、途中で途切れないことを検証する。
5. 専用リソースの作成・本番SQL・配備について対象と費用を確認してから実施する。
6. 公開先と別端末で、投稿から実際の音楽・映像の生成・再生まで確認する。

現在のビルド・受付テストの成功は、有料生成や本番再生の成功を示すものではない。
