# MV3の利用例

Background / 共通UI / ISOLATED / MAINのTypeScript例です。root exportからビルド済みパッケージをimportします。ChromeとFirefoxで同じ `ui.html` をpopup・side panel・popoutに再利用します。

リポジトリで実行:

```sh
bun install
bun run build
bun run build:example
```

Chromeは `examples/dist/chrome` を開発者モードの「パッケージ化されていない拡張機能を読み込む」で、Firefoxは `examples/dist/firefox/manifest.json` をabout:debuggingの「一時的なアドオンを読み込む」で選びます。通常の拡張機能インストールやストア公開は行いません。

actionを開くと、theme変更・panel表示・popout作成を実行できます。`https://example.com` を開くと、MAINが公開されたthemeを読み出します。この例のMAIN公開はread/watchだけです。ブラウザのnative gesture制限は [互換性](../docs/compatibility.md) を参照してください。

例のpopoutは既定でtabを関連付けません。関連tabのtitleを読む場合は、`ui.ts` のopenに利用側で取得した `associatedTabId` を追加します。対応するページにISOLATEDが注入されている必要があります。既存の同じreuseKeyのwindowを閉じてから試してください。

ソース例はtypecheckと、梱包パッケージの生成宣言に対する別consumerの型検査を通します。自動統合fixtureは `tests/browser/integration.ts` です（testsは配布物に含みません）。全操作の説明は [統合ガイド](../docs/integration.md) と [API索引](../docs/api.md) にあります。
