# 画面部品の出典

- audiocn-ds: https://github.com/hapx2yuki/audiocn-ds
- 参照した版: `b91f13cfc4f1d8107c21239800a3081e8248e3c8`
- MIT。著作権・許諾条件は [LICENSE.audiocn.txt](LICENSE.audiocn.txt) を保持。
- 公式レジストリ `https://audiocn-ds.vercel.app/r/{name}.json` から `shadcn@4.0.8 add` で導入。各部品・補助処理のソースをこのディレクトリで固定。
- Stone の値と基本テーマは同じ版の `app/globals.css` から抽出。追加トークンと material/surface は公式 `theme` から導入。
- 音声部品の補助ソースは、音源保存用ディレクトリと区別するため `lib/audio` から `lib/signal` へ移動し、import先だけを調整。
- 変更点: Theme Switcher の `useTheme` を同一オリジン専用のテーマ管理へ接続。インラインスクリプトを使わず、既存の厳格なCSPを維持するため。
- Phosphor、React、Base UI、Tailwind、フォントを含む依存関係は `package-lock.json` で固定。外部CDNやフォントサーバーへの接続は不要。
- M PLUS 2 / M PLUS 1 Code / DotGothic16 は Fontsource 経由、SIL Open Font License 1.1。各パッケージにライセンスを同梱。ビルド時にのみフォントを公開用ファイルへ出力し、Gitには含めない。

公式の規則: https://audiocn-ds.vercel.app/docs/ai/design-rules

Sidebarの開閉状態は画面内に保持し、Cookieの書き込みを省略しています。認証Cookieや既存のルーム情報には触れません。

Status Dotでは画面の日本語ラベルを読み上げにも使用し、生成状況が「ビルド中」と読まれないように調整しています。
