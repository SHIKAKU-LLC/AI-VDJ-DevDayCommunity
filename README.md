# AI VDJ

[公開リポジトリ](https://github.com/SHIKAKU-LLC/AI-VDJ-DevDayCommunity)

参加者が入力したプロンプトから音楽と映像を生成し、大画面で再生するアプリケーションです。
ブラウザからルームを作成し、参加・生成・再生まで操作できる構成を開発しています。

## 開発状況

Cloudflare Workers・D1・R2・Containersへの統合を進めています。
利用者にMacアプリの起動やAPIキーの入力を求めない構成を目指しています。
生成サービスのキーはサーバー側で管理し、ブラウザへ渡しません。

| 項目 | 状態 |
| --- | --- |
| ルーム作成・参加・大画面の画面 | 実装あり。サーバー側との接続を改修中 |
| 生成・音声処理・再生確認 | 共通実装と合成データのテストあり |
| D1・R2 | 基礎実装とテストあり。処理全体の移植は未完了 |
| Containersとの接続 | 開発中 |
| Cloudflare上での実生成・連続再生・本番公開 | 未検証 |

自動テストの成功だけを、実生成や本番再生の完了とは扱いません。

## 構成

| ディレクトリ | 内容 |
| --- | --- |
| `room-web/` | ルーム作成・参加・大画面再生の画面 |
| `cloud/cloudflare/` | D1・R2への接続 |
| `cloud/jobs/`、`cloud/worker/` | 生成の実行管理、品質確認、音声処理 |
| `cloud/server/` | サーバー実行の組み立て。DB接続をCloudflareへ移植中 |
| `integration/` | 音源・映像・再生処理との接続 |
| `snapshot/` | ブラウザ音声処理とDSPの共通モジュール |
| `tests/` | 合成データによる検証 |
| `docs/architecture.md` | 構成と検証の境界 |

## ローカル検証

Node.js 24、Python 3.11、ffmpegを使います。

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r qa-tools/runtime-requirements.txt
npm ci --prefix qa-tools --ignore-scripts --no-audit --no-fund
npm ci --prefix snapshot --ignore-scripts --no-audit --no-fund
npm ci --prefix cloud/cloudflare --ignore-scripts --no-audit --no-fund
python3 -m unittest discover -s tests -v
node --test --test-concurrency=4 --test-timeout=120000 tests/*.test.mjs snapshot/app/runtime/*.test.mjs integration/mac-host/*.test.mjs
```

テストに実際の音源、外部API、APIキー、有料生成は必要ありません。
音声処理を含む検証では`.venv/bin`を`PATH`へ追加するか、`VDJ_QC_PYTHON`でPythonの実行ファイルを指定してください。

## データと秘密情報

音源、映像、生成物、APIキー、ログイン情報、署名付きURLをGitへ追加しません。
素材は非公開の保管先で管理し、コードでは匿名IDとSHA-256を使って照合します。
費用上限・期限・ルームごとの操作権限はサーバー側で検証します。

コミット前の確認は[AGENTS.md](AGENTS.md)を参照してください。
同梱ライブラリのライセンス表記は[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)に記載しています。
