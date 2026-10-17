# 第三者ライブラリの表記

- QRコード処理のライセンス表記は`room-web/LICENSE.qr.txt`に保持しています。
- npm依存は各`package-lock.json`で版と取得元を固定しています。配布時には各パッケージのライセンス条件を確認してください。
- 各ソースファイルにある著作権・ライセンスのコメントは保持します。

## 同梱コードの出所

| 対象 | 出所・著作者 | ライセンス | 用途・変更 | 確認日 |
| --- | --- | --- | --- | --- |
| `room-web/qr-encoder.mjs` | [qrcode-generator 2.0.4](https://github.com/kazuhikoarase/qrcode-generator)、Kazuhiko Arase | MIT。本文は`room-web/LICENSE.qr.txt` | QRコードの行列・SVG生成。未使用のGIF・画像HTML出力を除去 | 2026-10-18 |

`room-web/qr-source.json`の元ソース・変更後ソースのSHA-256は、固定版パッケージと同梱ファイルに一致することを確認しています。著作権表示とMITライセンス本文は保持しています。

npmやPythonでインストールする依存パッケージ本体は、このリポジトリには同梱しません。配布物に含める場合は、その版のライセンスと表示義務を別途確認してください。

この文書は、依存ライブラリのライセンスを変更するものではありません。
