# Cloudflareへの移行

現在は、Workersによる画面配信とD1によるルーム作成・参加・投稿・受付切替まで接続している。
検証用WorkerとContainerをCloudflare上で組み立て・配備し、Container単独での合成音声処理を確認した。
音楽・映像の生成と連続再生への接続は未完了で、本番へは配備していない。
R2の単一素材を生成サービスへ渡す期間限定の取得処理は実装・単体検証済みで、生成処理からの呼出しは未接続。
受付画面は生成準備中であることを表示し、生成・演奏ボタンを有効にしない。

## 本番の組み立てと実行

本番はCloudflareのWorkers BuildsでGitHubから取得・ビルドし、Workers・D1・R2・Containersで実行する方針。
Air、Macの常駐プログラム、利用者のDockerには依存しない。利用者・審査員・オーナーはブラウザだけで接続する。
以下のローカル起動は開発時の任意の確認方法であり、本番の動作条件ではない。

2026-10-18に検証用Worker `ai-vdj-devdaycommunity-staging` を作成し、既存のGitHub連携とビルド用権限を接続した。
検証用の対象ブランチは `codex/cloudflare-runtime`。初回に自動開始された `main` のビルドは停止した。
ビルド・実行の確認結果と未完事項は [検証記録](../../docs/cloudflare-staging-check.md) を参照。

Workers Buildsの設定（検証用は保存済み、本番用は案）:

| 項目 | 設定案 |
| --- | --- |
| GitHub | `SHIKAKU-LLC/AI-VDJ-DevDayCommunity` のみ |
| ルート | リポジトリのルート |
| Node.js | `NODE_VERSION=24.22.0` |
| 検証用ビルド | `npm ci --prefix cloud/cloudflare --no-audit --no-fund && npm run build --prefix cloud/cloudflare -- --mode staging` |
| 検証用配備 | `cd cloud/cloudflare && npx cf deploy --prebuilt --mode staging` |
| 本番用ビルド | `npm ci --prefix cloud/cloudflare && npm run build --prefix cloud/cloudflare` |
| 本番用配備 | `cd cloud/cloudflare && npx cf deploy --prebuilt --mode production` |
| 検証ブランチ | `codex/cloudflare-runtime`。検証環境の作成・配備は承認済み |
| 本番ブランチ | `main`。PRのマージと公開は別途承認後 |

ContainersのDockerfileもWorkers Builds内で組み立てる。Containersは独立した検証用Workerで動作確認してから本番へ接続する。
ビルド用のGitHub連携・Cloudflare権限は対象を確認して設定する。生成用の秘密値はビルド変数に入れず、実行時のSecretとして別に設定する。
参考: [Containersの配備](https://developers.cloudflare.com/containers/guides/deploy/)、[Workers Buildsの設定](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)。

`Dockerfile` と `native-service.mjs` は、既存のPython・ffmpeg検査をContainersから呼ぶための準備。
通信はサーバー間の認証を必須とし、入力ファイルの上限とハッシュを確認する。同時処理は1件。
任意のURL、ファイルパス、コマンド、利用者による検査結果の指定は受け付けない。
検査用HTTP処理と実際のPython検査をローカルで確認し、Cloudflare上でもイメージ作成・配備・合成音声の処理を確認済み。

`worker-with-containers.mjs` と `native-container.mjs` で、処理用Containerを呼ぶ非公開の接続を定義している。
通常の画面/APIからこの接続へ転送する経路は設けていない。実生成からの呼び出しは今後接続する。
Containerは最大1台・同時処理1件・未使用3分で停止し、外部通信とSSHは無効にする。
サーバー間の認証値は実行時に生成してDurable Object内に保持する。利用者の入力やMacのKeychainは使わない。
再起動時の認証継続・不正な経路の拒否・同時処理制限・内部エラーの非公開化は単体テスト済み。

検証環境だけに `/api/staging/native-check` を設ける。同一オリジンから空のPOSTを1回受けると、
Container内で固定の合成音声を作り、既存のPython・ffmpeg検査へ渡す。GETはその結果の確認だけを行う。
開始記録は新規の検証用Durable Objectに先に保存し、再送・再起動・失敗による再実行を防ぐ。
入力素材・URL・コマンドは指定できず、D1・R2や生成サービスには書込み・要求を行わない。
本番モードではこの経路を有効にしない。
検証用Workerでは `**/*.md` をビルドの除外対象にし、文書だけの更新でContainerを再構築しない。

`staging` モードは `ai-vdj-devdaycommunity-staging`、本番モードは `ai-vdj-devdaycommunity` を対象にする。
それぞれにContainerを定義するため、通常のWorkerのプレビューだけでContainerの検証を済ませない。
Containerを含む `cf build` はイメージも組み立てるので、CloudflareのWorkers Builds上で実行する。
Airで実行する `build:local` はContainerを含まず、配信とルームAPIの確認用である。

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
