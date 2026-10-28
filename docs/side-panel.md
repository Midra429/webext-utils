# sidePanel API

`@midra/webext-utils/sidePanel` の `webextSidePanel` は、Chromeの `sidePanel` とFirefoxの `sidebarAction` を操作します。factoryやBackgroundの登録は不要です。rootからも同じ公開名・型をimportできます。import時にはnative APIを読まず、listener・Port・保存データを作りません。

```ts
import { webextSidePanel } from '@midra/webext-utils/sidePanel'

await webextSidePanel.setPage('panel.html')
await webextSidePanel.setPage('panel.html?detail', { tabId: 42 })
const page = await webextSidePanel.getPage({ tabId: 42 })

// 実際の拡張機能UIのクリックから、事前awaitなしで呼ぶ。
document.querySelector<HTMLButtonElement>('#open-panel')?.addEventListener('click', () => {
  void webextSidePanel.open().catch(console.error)
})
```

## 操作と型

| API | 戻り値・対象 |
| --- | --- |
| `open(target?)` | `Promise<void>`。省略=active window、明示は `{ windowId }` または `{ tabId }` |
| `close(target?)` | `Promise<void>`。省略=active window。Chromeのwindow指定はglobal panel、tab指定はそのtab固有panelだけを閉じる |
| `setPage(path, scope?)` | `Promise<void>`。省略=global設定。`{ tabId }`、Firefoxのみ `{ windowId }` |
| `getPage(scope?)` | `Promise<string \| undefined>`。有効な設定を自拡張機能の絶対URLに正規化。未設定だけ `undefined` |
| `getState({ windowId })` | `Promise<SidePanelState>`。Firefoxはnative確定値、Chromeは `unknown` |
| `onOpened(handler)` / `onClosed(handler)` | `Unsubscribe`。Chromeのnativeイベントだけを購読。Firefoxは同期的に非対応エラー |
| `getCapabilities()` | `SidePanelCapabilities`。そのcontextでのメソッド・イベントの機能検出 |

`SidePanelTarget` / `SidePanelScope` はtabIdとwindowIdの排他的unionです。両方指定、明示的な空object、負数・小数・無限大のIDは拒否します。特殊IDの `WINDOW_ID_CURRENT` 等も渡しません。省略は `undefined` を使います。

設定のglobal scopeは、全windowを同時に開くという意味ではありません。Chromeの `open({ tabId })` はnativeと同様にtab固有設定がなければglobal panelを開けます。`close({ tabId })` の契約はそれより厳しく、他のpanelを代わりに閉じません。

```ts
const state = await webextSidePanel.getState({ windowId: 1 })
if (state.state === 'unknown') {
  console.log(state.reason) // 'NATIVE_STATE_UNAVAILABLE'
} else {
  console.log(state.state, state.source) // 'open' | 'closed', 'native'
}

const capabilities = webextSidePanel.getCapabilities()
if (capabilities.events.opened) {
  const stop = webextSidePanel.onOpened((event) => {
    console.log(event.windowId, event.tabId, event.page, event.source)
  })
  // view終了時などに解除。複数回呼んでも安全。
  stop()
}
```

公開型は `SidePanelTarget`、`SidePanelScope`、`SidePanelState`、`SidePanelEvent`、`SidePanelCapabilities`、共通の `WebextError` / `ErrorCode` / `Unsubscribe` です。Chrome/Firefoxのambient型やDOM型を利用者に要求しません。

capabilitiesのshape:

```ts
{
  open: { activeWindow: boolean, window: boolean, tab: boolean },
  close: { activeWindow: boolean, window: boolean, tab: boolean },
  setPage: { global: boolean, window: boolean, tab: boolean },
  getPage: { global: boolean, window: boolean, tab: boolean },
  nativeState: boolean,
  events: { opened: boolean, closed: boolean },
}
```

値はその場で機能検出した結果で、権限・window/tabの存在・gestureの保証ではありません。操作時にもnative APIを取得し直し、receiverを保持します。`browser` が存在するだけではFirefoxと判定しません。利用者が部分的なpolyfillを置いた場合も、メソッドごとに `browser` / `chrome` を探します。

## ブラウザ差とgesture

| 操作 | Chrome 142+ | Firefox 145+ |
| --- | --- | --- |
| active-window open/close | `windows.getLastFocused()` で具体的なIDを取得してnative呼び出し | 引数なしのnative APIを同期に開始 |
| 明示window/tabへのopen | 対応 | `UNSUPPORTED_OPERATION`、native呼び出し前に拒否 |
| 明示windowへのclose | 対応。window内のglobal panelが対象 | 非対応 |
| 明示tabへのclose | 145+のみ。142–144・版不明は事前拒否 | 非対応 |
| global/tabページ設定・取得 | 対応 | 対応。tab固有設定はwindow内sidebarの内容の切替 |
| windowページ設定・取得 | 事前拒否 | 対応 |
| 開閉状態 | `unknown` | `sidebarAction.isOpen` による確定値 |
| opened/closedイベント | native `onOpened` / `onClosed` | 非対応。unload等で代替しない |

Chrome142–144のnative `close({ tabId })` はglobal panelも閉じ得ます。145からglobalへのfallbackをせずrejectするため、この既知の意味の差だけ `navigator.userAgent` のChrome/Chromium/HeadlessChrome majorを読みます。145未満・版不明は `UNSUPPORTED_OPERATION`。メソッドが存在するだけで安全と判断しません。142/145/156でnativeの差とwrapperの振る舞いを実機検証しています。

明示targetのChrome操作と、引数なしFirefox操作には事前のawaitを入れません。Chromeの引数省略経路だけはactive windowを取得するawaitが入ります。今回のChrome142/145/156ではこのawait後も開閉できました。Firefox145/156/158では、クリック後に `await windows.getLastFocused()` を挟むとopen/closeは `USER_GESTURE_REQUIRED` になり、元の開閉状態を保持しました。任意のawait・タイマー・メッセージrelay後までgestureを保証しません。Chromeも可能なら既知のwindowId/tabIdをクリック時に直接指定してください。

Chromeの設定・enabled・生存中のpanel文書・イベント履歴は可視状態を証明しないため、`getState` は履歴を保存せず常に `unknown` を返します。windowの実在もこの結果だけからは証明しません。Firefoxではnativeのbooleanを `open` / `closed` に変換し、nativeの失敗を `closed` に置き換えません。`toggle` は提供しません。

## ページとエラー

- 相対pathは拡張機能rootを基準に解決し、query/hashも保持します。Chromeの `setOptions` にはroot相対path、Firefoxの `setPanel` には絶対URLを渡します。
- 外部URL・他の拡張機能・opaque URL・空文字は `INVALID_ARGUMENT`。nativeが外部panel設定を返した場合は `UNSUPPORTED_OPERATION` です。
- `setPage` は `enabled` を変更しません。既存のdisabled設定の有効化は利用側のnative設定で行います。`getPage` は設定を返し、表示中であるとは主張しません。
- nativeの未提供メソッド/イベントは `UNSUPPORTED_OPERATION`。SSRやMAIN等、拡張機能runtimeが使えない場所の操作は `CONTEXT_UNAVAILABLE`。
- gesture/permission/tab/windowの明確なnative文言は、それぞれ `USER_GESTURE_REQUIRED` / `PERMISSION_DENIED` / `TAB_NOT_FOUND` / `WINDOW_NOT_FOUND` に変換します。それ以外は `NATIVE_ERROR`。`operation` は `sidePanel.open` 等、nativeの `cause` を保持します。
- nativeイベントは `{ windowId, tabId?, page, source: 'native' }` に正規化します。不正ID・自拡張機能外のpathは配信しません。未購読時のlistenerはありません。

MAIN向けの開閉RPCは追加していません。gestureや権限を維持できる保証がなく、直接使える拡張機能UIが入口です。popoutはこのモジュールの `getPage(scope)` を再利用します。[統合例](integration.md) を参照してください。

## Manifestと入口

Chrome:

```json
{
  "manifest_version": 3,
  "name": "Example",
  "version": "1.0.0",
  "minimum_chrome_version": "142",
  "permissions": ["sidePanel"],
  "side_panel": { "default_path": "panel.html" },
  "action": {},
  "background": { "service_worker": "background.js", "type": "module" }
}
```

Firefox:

```json
{
  "manifest_version": 3,
  "name": "Example",
  "version": "1.0.0",
  "browser_specific_settings": {
    "gecko": { "id": "example@example.com", "strict_min_version": "145.0" }
  },
  "sidebar_action": {
    "default_panel": "panel.html",
    "default_title": "Example",
    "open_at_install": false
  },
  "action": {},
  "background": { "scripts": ["background.js"], "type": "module" }
}
```

`open_at_install: false` はFirefoxのインストール直後の自動表示を抑えたい場合の選択です。Firefoxに `sidePanel` 権限は指定しません。Manifest、HTMLの実体、表示の入口は利用側で用意します。サイドパネルの定義だけではChromeの開く入口になりません。上記の `action: {}` ではBackgroundで次のlistenerを同期登録できます。

```ts
import { webextSidePanel } from '@midra/webext-utils/sidePanel'

chrome.action.onClicked.addListener(() => {
  void webextSidePanel.open().catch(console.error)
})
```

これは利用側のnative型を使う例です。`action.default_popup` がある構成では `onClicked` が発火しないため、popup内のボタンから `webextSidePanel.open()` を直接呼びます。このライブラリはManifestを書き換えたり、actionの動作を自動変更したりしません。

根拠: [Chrome sidePanel](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)、[Firefox sidebarAction](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/sidebarAction)、[open](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/sidebarAction/open)、[close](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/sidebarAction/close)、[setPanel](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/sidebarAction/setPanel)、[sidebar_action](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/sidebar_action)。実行結果・未検証条件は [検証結果](testing.md) を参照してください。
