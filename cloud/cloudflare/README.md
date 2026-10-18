# Cloudflareへの移行

Workers、D1、非公開R2、Containersで動作するルームと生成・再生処理を実装している。
検証用WorkerとContainerはCloudflare上で組み立て・配備済みで、合成音声の処理を確認した。
今回追加した音楽・映像の生成、音量・形式の調整、ブラウザ連続再生については
[生成処理の説明と検証状況](../../docs/cloudflare-generation.md)を参照。
生成処理は既定で無効。実行時Secret・期限内のD1イベント・生成の有効化をすべて確認するまで受付画面を有効にしない。
本番での実生成・連続再生が済んだことを示すものではない。

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

### PRのビルド検証

本番Workerの`Builds → Previews Base`では、既定の`wrangler preview`を使用しない。
既に作成済みのPR用環境は共通設定を引き継ぎ直さないため、対象のPreviewを選び、
その`Settings → Builds`にも同じ設定を保存する。
このリポジトリは`cloudflare.config.ts`を使うため、次の設定でPRのビルドと配備前検査を行う。

- ビルド: `npm ci --prefix cloud/cloudflare --no-audit --no-fund && npm run build --prefix cloud/cloudflare`
- 配備前検査: `cd cloud/cloudflare && npx cf deploy --prebuilt --mode production --dry-run`
- ビルド変数: `NODE_VERSION=24.22.0`、本番と同じ公開オリジン・D1 ID、`VDJ_EVENT_ID=judge-preview`、`VDJ_GENERATION_ENABLED=false`

ここでは検証だけを行い、Workerの切替、D1の更新、有料生成は行わない。
実際に操作できる検証環境は、別Workerの`staging`モードを使う。
設定を保存したら、対象PRの最新コミットでビルドコマンドと検証結果を確認する。

`Dockerfile` と `native-service.mjs` は、既存のPython・ffmpeg検査をContainersから呼ぶための準備。
通信はサーバー間の認証を必須とし、入力ファイルの上限とハッシュを確認する。同時処理は1件。
任意のURL、ファイルパス、コマンド、利用者による検査結果の指定は受け付けない。
検査用HTTP処理と実際のPython検査をローカルで確認し、Cloudflare上でもイメージ作成・配備・合成音声の処理を確認済み。

`worker-with-containers.mjs` と `native-container.mjs` で、処理用Containerを呼ぶ非公開の接続を定義している。
通常の画面/APIから任意の処理を転送する経路は設けていない。生成処理だけが型と上限を固定して呼び出す。
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
| `VDJ_GENERATION_ENABLED` | 承認後に`true`。既定は`false` |
| `VDJ_DECISIONS_ENABLED` | 再生候補のDecisions API連携。既定は`false`。実行時Secret `OPENAI_API_KEY`も必要 |

これらは接続先・動作の設定であり、APIキーを入れない。
生成サービスの秘密値は実行時Secretの`FAL_KEY`に登録する。画面用ファイルやD1のルーム文書には保存しない。
利用者にAPIキーの入力やMacへの接続は求めない。

Decisions連携もサーバー側だけで動く。投稿順と一巡を維持し、同じ参加者の繰り返し採用を調整する。
設定・呼出回数の上限・確認方法は[Decisionsの説明](../../docs/decisions-playback.md)を参照。

Workerは同一オリジンのAPIだけを受付し、ルームの権限は個別のランダム値で確認する。
D1には権限のハッシュを保存し、公開レスポンスから内部の操作記録を除く。
期限・受付上限・更新の競合はD1の条件付きSQLで確認する。

## 残っている作業

1. 検証用に今回の接続処理を配備し、承認後に実行時Secret・期限と上限を指定したD1イベント・生成の有効化を設定する。
2. Cloudflare上でプロンプトから音楽・映像を実際に生成し、ブラウザの曲切替と連続再生を計測する。
3. 本番公開の対象・期間・予算を確認し、承認後に本番へ反映する。
4. 公開先で所有者と参加者の操作、実生成、実再生を確認する。

現在のビルド・受付テストの成功は、有料生成や本番再生の成功を示すものではない。
