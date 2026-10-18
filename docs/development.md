# 技術構成と開発手順

[READMEへ戻る](../README.md)

## 技術構成

```text
オーナー・参加者のブラウザから、言葉と任意の画像を投稿
    ↓
Workersで受付・権限確認 ／ D1でルーム・投稿・費用を記録
    ↓
Durable Objectsで生成を管理（画像ありの場合はWorkers AIで特徴を解析）
    ↓
fal.aiで音楽・映像を生成 → Containersで形式調整・品質検査
    ↓
非公開R2へ保存 → オーナーのブラウザへ配信
    ↓
投稿順・採用回数から次の候補を準備
    ├─ 繰り返し採用の調整：OpenAI Decisions APIへ事前問い合わせ
    └─ サーバーで回答を検証。未着・失敗時も同じ公平ルールで選択
    ↓
大画面で連続再生・曲と映像の切り替え・音に反応する描画
```

| 担当 | 技術・実装 |
| --- | --- |
| 画面とAPI | React 19.2、audiocn-ds、Tailwind CSS v4、Base UI、Cloudflare Workers |
| ルーム・投稿・費用予約 | Cloudflare D1 |
| 受付・公平な再生順／投稿ごとの生成処理 | Cloudflare Durable Objectsを分離して管理 |
| 繰り返し採用時の選択 | OpenAI Decisions API / `gpt-6-luna` / `choice`。固定ルールで検証し、失敗時は即座に代替 |
| 画像の特徴解析 | Cloudflare Workers AI / Moondream |
| 音楽生成 | fal.ai / Stable Audio 3 |
| 映像生成 | fal.ai / MiniMax H3 Max。画像の有無で生成方法を切り替え |
| 形式調整と検査 | Cloudflare Containers / Node.js・Python・ffmpeg |
| 素材の保存 | 非公開のCloudflare R2 |
| 曲と映像の連続再生 | Web Audio API、HTML video、Canvas |

生成モデルとクラウド側の処理はサービスが管理します。
利用者の端末は、ブラウザで投稿や再生を担当します。

## 継続して使うための設計

- **生成費用の管理**：生成前に料金・残高・予約上限を確認し、ルームとイベント全体の枠をD1で管理します。
- **重複生成の防止**：送信記録と生成の進行状態を保存します。結果が不明な有料要求を自動で送り直さず、確認が必要な状態として止めます。
- **素材の品質検査**：音量・形式を調整し、動画の黒画面、静止状態、急激な明暗変化などを検査してから再生用素材として渡します。
- **権限の分離**：オーナーと参加者の操作範囲を分け、別のルームの操作や素材取得を拒否します。APIキーはサーバー側で管理します。
- **画像の扱い**：投稿画像は画像解析と映像生成に使用します。通常の参加者の画像を、ほかのルームの共通プリセットへ自動追加することはありません。
- **入力と指示の分離**：投稿された言葉や画像内の文字を、共通の制作方針やシステム設定を変更する指示として扱わない構成にしています。

## コードを読む方へ

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

## データと秘密情報

音源、映像、生成物、APIキー、ログイン情報、署名付きURLをGitへ追加しません。
素材は非公開の保管先で管理し、コードでは匿名IDとSHA-256を使って照合します。
費用上限・期限・ルームごとの操作権限はサーバー側で検証します。

コミット前の確認は[AGENTS.md](../AGENTS.md)を参照してください。
同梱ライブラリのライセンス表記は[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)に記載しています。
