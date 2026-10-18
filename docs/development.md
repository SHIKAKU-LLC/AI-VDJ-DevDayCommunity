# 開発ガイド

[READMEへ戻る](../README.md)

以下のコマンドはリポジトリのルートで実行します。

## ディレクトリ構成

| ディレクトリ | 内容 |
| --- | --- |
| `room-web/` | ルーム作成・参加・投稿・大画面再生 |
| `cloud/cloudflare/` | Workers・D1・R2・Containersを使う本番処理 |
| `cloud/jobs/`、`cloud/worker/` | 生成の実行管理、品質確認、音声処理 |
| `cloud/server/` | サーバー共通処理とPostgreSQL向け実装 |
| `integration/` | 音源・映像・再生処理との接続 |
| `snapshot/` | ブラウザ音声処理とDSPの共通モジュール |
| `tests/` | 合成データによる検証 |

## 開発者向けのローカル検証

以下は開発用の手順です。本番サービスを体験するだけなら実行する必要はありません。

Node.js 24、Python 3.11、ffmpegを使います。

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r qa-tools/runtime-requirements.txt
npm ci --prefix qa-tools --ignore-scripts --no-audit --no-fund
npm ci --prefix snapshot --ignore-scripts --no-audit --no-fund
npm ci --prefix cloud/cloudflare --ignore-scripts --no-audit --no-fund
npm ci --prefix room-web/console --no-audit --no-fund
npm test --prefix room-web/console
npm run build --prefix room-web/console
python3 -m unittest discover -s tests -v
node --test --test-concurrency=4 --test-timeout=120000 tests/*.test.mjs snapshot/app/runtime/*.test.mjs integration/mac-host/*.test.mjs
```

テストに実際の音源、外部API、APIキー、有料生成は必要ありません。
音声処理を含む検証では`.venv/bin`を`PATH`へ追加するか、`VDJ_QC_PYTHON`でPythonの実行ファイルを指定してください。

## リポジトリへの追加

コミット前の検査は[AGENTS.md](../AGENTS.md)を参照してください。READMEに掲載するGIFと管理画面画像は、ユーザーが指定した3点を `docs/readme-media/` に収録しています。

同梱ライブラリのライセンス表記は[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)、操作画面の利用部品は[console/THIRD_PARTY.md](../room-web/console/THIRD_PARTY.md)を参照してください。
