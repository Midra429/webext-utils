# 利用例

Chrome と Firefox に読み込める拡張機能の例です。同じ `ui.html` をポップアップ・サイドパネル・popout で使います。

| ファイル | 内容 |
| --- | --- |
| [background.ts](background.ts) | Background の初期化、受信ハンドラー、データの移行、サイドパネルの開閉通知 |
| [ui.ts](ui.ts) / [ui.html](ui.html) | ポップアップ・サイドパネル・popout 共通の UI |
| [isolated.ts](isolated.ts) | ISOLATED world: MAIN world へのブリッジとストレージの公開 |
| [main.ts](main.ts) | MAIN world: 公開されたメッセージとストレージを使う |
| [shared.ts](shared.ts) | メッセージとストレージの型 |
| [manifest.chrome.json](manifest.chrome.json) / [manifest.firefox.json](manifest.firefox.json) | ブラウザごとの Manifest |

## 動かす

リポジトリで次を実行します。

```sh
bun install
bun run build
bun run build:example
```

- Chrome: `chrome://extensions` でデベロッパーモードを有効にし、「パッケージ化されていない拡張機能を読み込む」で `examples/dist/chrome` を選びます。
- Firefox: `about:debugging` の「一時的なアドオンを読み込む」で `examples/dist/firefox/manifest.json` を選びます。

ツールバーのアイコンからポップアップを開くと、テーマの変更・サイドパネルの開閉・popout の作成を試せます。`https://example.com` を開くと、MAIN world が公開されたテーマを読み込みます（この例の公開は読み込みと監視だけです）。

popout は既定ではタブを関連付けません。関連タブのタイトルを読むには、`ui.ts` の `webextPopout.open()` に `associatedTabId` を追加してください。

詳しくは [はじめに](../docs/getting-started.md) を参照してください。
