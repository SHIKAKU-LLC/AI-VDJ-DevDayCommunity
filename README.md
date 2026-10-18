# AI VDJ

参加者のひとことから音楽と映像を生成し、みんなで作った演出を大画面で楽しむアプリケーションです。

**[本番サービスを開く](https://ai-vdj-devdaycommunity.hapx2yuki.workers.dev/room)**

ルームの作成から参加・投稿・再生まで、ブラウザだけで操作できます。
アプリのインストール、APIキーの入力、Macとの接続は不要です。
大画面で再生する端末はPCのChromeをおすすめします。参加者はスマホからも投稿できます。

## 審査・体験用の使い方

1. **ルームを作る**

   [本番サービス](https://ai-vdj-devdaycommunity.hapx2yuki.workers.dev/room)を開き、**「ルームを開く」**を押します。その端末がオーナーの再生画面になります。
2. **参加者を招待する**

   オーナー画面のQRコードを読み取るか、**「URLをコピー」**で参加用URLを共有します。参加者は呼ばれたい名前を入力し、**「参加する」**を押します。
3. **プロンプトと、任意で画像を投稿する**

   「ネオンの猫が踊る」「宇宙を走る重低音」など、短い言葉を入力します。画像を使う場合だけ**「参考画像（任意）」**から添付し、**「このアイデアを送る」**を押します。画像なしでも生成できます。オーナー自身も**「音楽・映像を生成する」**から投稿できるため、1人でも試せます。
4. **生成を待つ**

   オーナー画面の**「自動生成 ON」**を確認します。OFFの場合はボタンを押してONにします。投稿から音楽と映像が生成され、**「届いたアイデア」**に進み具合が表示されます。生成には数分かかる場合があります。
5. **音楽と映像を大画面で楽しむ**

   準備完了後、オーナー画面で**「再生する」→「大画面にする」**を押します。音楽を流しながら、生成映像と準備済みの映像が順に切り替わります。

- 1ルームで最大5曲を生成できます。1曲は音楽60秒と、異なる12秒映像6本で構成されます。
- 音楽と映像は別々に切り替わり、次の映像を待つ間も準備済みの映像で演出を続けます。
- 再生中はオーナーのタブを開いたままにしてください。全画面の解除は**Esc**、再生の停止は**「音を止める」**です。
- 生成費用は運営側が負担し、参加者への請求はありません。審査用の受付期間・生成枠には上限があります。

## 実行環境と確認状況

画面配信・ルーム管理・生成処理はCloudflare Workers・D1・R2・Containersで動作し、
外部の生成サービスと連携します。生成サービスのキーはサーバー側で管理し、ブラウザへ渡しません。

2026年10月18日に、本番サービスをMacBook AirのChromeから開き、約3分47秒の全画面連続再生を確認しました。
画像から作り直した8本すべてが音楽とともに切り替わり、音声・映像の読み込みエラーと、
映像の表示欠落・停止は検出されませんでした。別ブラウザ・外部モニター接続での確認は含みません。

## 構成

| ディレクトリ | 内容 |
| --- | --- |
| `room-web/` | ルーム作成・参加・大画面再生の画面 |
| `cloud/cloudflare/` | Workers・D1・R2・Containersを使う本番処理 |
| `cloud/jobs/`、`cloud/worker/` | 生成の実行管理、品質確認、音声処理 |
| `cloud/server/` | サーバー共通処理とPostgreSQL向け実装 |
| `integration/` | 音源・映像・再生処理との接続 |
| `snapshot/` | ブラウザ音声処理とDSPの共通モジュール |
| `tests/` | 合成データによる検証 |
| `docs/architecture.md` | 設計方針と移行時点の検証範囲 |

## 開発者向けのローカル検証

以下は開発用の手順です。本番サービスを体験するだけなら実行する必要はありません。

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
