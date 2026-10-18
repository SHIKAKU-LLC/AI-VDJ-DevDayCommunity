# 上映専用タブの確認

## 変更

オーナー画面の「別タブで大画面を開く」から、映像と投稿者名だけを表示するタブを開く。説明ラベル「このアイデアから生まれました」は表示しない。表示タブの映像をクリックするか、Fキーで全画面にし、Escキーで解除する。

音声・選曲・採用回数の更新はオーナー画面が引き続き担当する。表示タブは消音した動画と描画だけを担当し、API通信やAudioContextの作成を行わない。元のオーナータブは開いたままにする。

別タブを `noopener,noreferrer` で開き、オーナーの認証情報を含むセッション保存領域を複製しない。ランダムな識別子のBroadcastChannelで、読み込み済み動画の同一オリジンBlob URL、再生時計、投稿者名、描画用の信号だけを共有する。表示側から再生・生成の操作は受け付けない。

## ローカルの合成データによる確認

2026年10月18日、MacBook AirのChromeと `scripts/serve_console_fixture.mjs` を使用した。有料生成・本番DB変更は行っていない。

| 確認項目 | 結果 |
| --- | --- |
| 全画面の継続再生 | 40秒・160回の観測。4セットを表示し、映像なし0回、停止0回、動画時計の停滞0回 |
| 投稿者名の切替 | 「オーナー」と「AI VDJ プリセット」を確認。説明ラベルなし |
| 表示専用 | ボタン・入力・音声要素・フォーム0個。全動画が消音。表示タブのAPI通信0件 |
| 認証分離 | `window.opener` なし、表示タブにオーナーの保存情報なし、オーナー用コードの読み込みなし |
| 再読み込み | 表示用識別子だけで再接続。生成・採用の重複操作なし |
| 終了 | 表示タブを閉じてもオーナー側の再生は継続。オーナー終了後は表示側も停止 |
| 大画面・狭い画面 | 1470px幅と390px幅で確認。表示専用画面の横はみ出しなし |
| 描画の独立性 | オーナーの描画ループを開始せずに信号を取得できることを単体テストで確認 |

これは合成素材による動作確認であり、本番素材での確認や外部モニター・実機音声の評価とは区別する。本番反映はPRのCI成功と承認後に行う。

## 再確認のコマンド

```bash
node --test tests/judge-display.test.mjs tests/judge-vj.test.mjs
npm test --prefix room-web/console
npm run build:local --prefix cloud/cloudflare
python3 -m unittest discover -s tests -v
python3 scripts/check_repository.py
python3 scripts/check_repository.py --staged
```

Macの旧native関連テストをまとめて動かす場合は、Pythonの仮想環境をPATHに含め、`VDJ_QC_PYTHON` と `VDJ_QC_DSP` に検証用のPythonとDSPスクリプトを指定する。
