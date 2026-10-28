# 対応環境とManifest

計画で固定した対象はdesktop Chrome **142–156** / Firefox **145–158**です（基準日2026-10-21）。検証済みの版・OSは [検証結果](testing.md) を参照してください。macOS以外や全中間バージョンを実機検証したという意味ではありません。ブラウザ更新時には同じfixtureで再検証してください。

| 機能 | Chrome | Firefox |
| --- | --- | --- |
| Background | MV3 Service Worker | MV3非永続background page |
| messaging | Promise送信、非async onMessage / sendResponse / return true | 同じ通信契約。browser / chromeの部分polyfill共存を機能検出 |
| MAIN | ISOLATEDとのJSON文字列CustomEvent、公開policy必須 | 同じ。ページから秘密・認証は保証できない |
| storage | local / sync / session、Web Locks | 同じ。sync移行は端末内の復旧支援に限定 |
| side panel | `sidePanel`。stateはunknown、142–144のtab closeは事前拒否 | `sidebarAction`。active-window開閉のみ、native開閉イベントなし |
| popout | `windows.create({ type: 'popup' })` とsession記録 | 同じ。初期about:blankを考慮 |
| import / types | ESM、サブパス、Tree Shaking | 同じ。公開宣言にbrowser固有ambient型は不要 |

## 確認されたnative storageの制約

Firefox156.0.1の `storage.session` は、名前空間なしの `toString` を保存してもnative getから値を返さないケースを確認しています。getKeysにはキーが存在し、native APIのみの呼び出しでも再現します。`settings.toString` のようにnamespaceを付けたキーを使用してください。Chromeの全areaとFirefoxのlocal/syncでは同じ試験が成功しています。保存形式の互換性を保つため、ライブラリによる暗黙のキー変換は行いません。[今回の失敗を含む検証結果](testing.md)を参照してください。

## 利用側で用意する設定

完全なMV3 ManifestとHTMLの実体は [Chrome例](../examples/manifest.chrome.json) / [Firefox例](../examples/manifest.firefox.json) にあります。ライブラリはManifestや元のaction/sidebar設定を書き換えません。

| 設定 | 用途 |
| --- | --- |
| `permissions: ["storage"]` | storage操作、messagingの受信登録復元、popoutのsession管理 |
| Chromeの `"sidePanel"` 権限と `side_panel.default_path` | サイドパネルのページと操作 |
| Firefoxの `sidebar_action.default_panel` | サイドバーのページ。`sidePanel` 権限は指定しない |
| `action.default_popup` | popupとして再利用するHTML。これがある場合 `action.onClicked` は発火しない |
| `host_permissions` と `content_scripts.matches` | 対象ページへのISOLATED / MAIN入口の注入 |
| `tabs` または対象URLを許可するhost権限 | tabのURL / title等の機密フィールド取得。window作成だけならtabs権限は不要 |
| `options_ui` | Optionsとして利用するページ。専用入口でcontextを明示登録 |

Chromeのpanelは定義だけでは開く入口になりません。例ではpopup内ボタンから `webextSidePanel.open()` を直接呼びます。Firefoxもgestureを必要とし、外部APIのawaitやBackgroundへのrelay後に同じgestureを保証しません。

MAINにはnative拡張機能権限を与えません。ISOLATED側で固定宛先、origin、メッセージ別validator、storageキー別read/write/watchを指定します。sessionのContent Script公開は既定で無効です。

根拠: [Chrome SW lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)、[Chrome sidePanel](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)、[Firefox background](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background)、[Firefox sidebar open](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/sidebarAction/open)、[Chrome tabs permission](https://developer.chrome.com/docs/extensions/reference/api/tabs#permissions)。個別の非対応と失敗は各APIガイドを参照してください。
