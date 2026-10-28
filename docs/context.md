# webextContext

```ts
import {
  webextContext,
  isWebextError,
  type ContextInfo,
} from '@midra/webext-utils/context'
```

ルート `@midra/webext-utils` からも同じ公開名をimportできます。import時にはブラウザglobalへのアクセス、listener登録、通信、storage読み取りをしません。

| API | 戻り値 | 動作 |
| --- | --- | --- |
| `get()` | `ContextInfo` | 同期証拠と直近の解決結果を返す |
| `resolve()` | `Promise<ContextInfo>` | 自身のtab/window、native contexts、popout記録を再取得する |
| `register(role)` | `() => void` | 既知の役割を宣言する。解除は冪等 |

`ContextInfo` は `kind` で絞り込める読み取り専用unionです。結果オブジェクトはfreezeしています。

| kind | 追加項目 |
| --- | --- |
| `background` | `implementation: 'service-worker' \| 'page'` |
| `content-script` | `world: 'ISOLATED' \| 'MAIN'` |
| `popup`, `side-panel`, `options`, `extension-page`, `devtools`, `unknown` | 共通メタデータのみ |
| `popout` | `origin: 'popup' \| 'sidePanel'`、必須 `windowId`、任意 `associatedTabId` |

共通項目は `source: 'native' | 'registered' | 'verified-record' | 'unknown'` と、確認できた `tabId` / `frameId` / `windowId` / `documentId` / `instanceId` です。nativeの `-1` はIDとして公開しません。native解決時の `instanceId` は `contextId`、popoutでは記録のtokenです。DevToolsの検査対象tabを自己の `tabId` として扱いません。

同期判定では自身の拡張機能URL、SW global、Background Window、`getViews()` の自己Window一致を使用します。Firefoxの `sidebar` は `side-panel` に正規化します。非同期では `getContexts()` を自身のtab/window・URL・同期証拠で絞り、一意に照合できた場合だけ分類します。同じURLの複数候補を先頭一致で選びません。非表示の文書も存在し得るため、このAPIは可視状態を保証しません。

OptionsのManifestパスだけでは用途を判定しません。通常タブで開いた同じHTMLは `extension-page` です。Optionsとして使う入口で `register({ kind: 'options' })` を呼んでください。MAINは入口で `register({ kind: 'content-script', world: 'MAIN' })` が必要です。

登録は自己申告です。tab/window IDは渡せません。`popout` / `unknown` は登録できません。同じ役割の複数登録は独立して解除できます。異なる登録やnative証拠との矛盾は `INVALID_ARGUMENT` です。後から `resolve()` で矛盾が判明した場合もエラーになります。

popoutの予約query `__webext_utils_popout` があれば、同期判定は照合まで `unknown` です。sessionの `__webext_utils:popout:<token>` にあるversion 1のready記録と、token、元page、現在のtab/window IDを照合します。hashや他のqueryは維持します。pending記録は25ms間隔で最大4回読み、readyになるまで `popout` にしません。不一致や未保存は `unknown`、native storageの失敗は例外です。記録の作成・復旧・cleanupは [popoutモジュール](popout.md) が担当します。共通HTMLでmessagingの受信handlerを登録する場合は、照合前のunknownを避けるため `getCurrent()` と `resolve()` の後に登録してください。起動直後のpending復旧も必要な場合は `await webextPopout.getCurrent()` の後に `resolve()` で判定できます。

`get()` は解決済み情報を保持します。session記録の変更を直ちに確認したい場合は `resolve()` を呼んでください。URL/文書が変わった場合とBFCacheへの出入りではcacheを破棄します。最初の `resolve()` で `pagehide` / `pageshow` の監視を設けます。監視は文書の寿命に従い、nativeイベントlistenerやPortを常駐させません。

SSRではimportと `get()` が利用でき、結果は `unknown` です。文書も拡張機能SWもない環境の `resolve()` は `CONTEXT_UNAVAILABLE`、native API失敗はcauseを保持した `NATIVE_ERROR` です。通信先に転送する際にcauseやstackをそのまま公開しないでください。

```ts
try {
  await webextContext.resolve()
} catch (error) {
  if (isWebextError(error)) console.error(error.code, error.operation)
}
```

APIの根拠: [Chrome runtime.getContexts](https://developer.chrome.com/docs/extensions/reference/api/runtime#method-getContexts)、[MDN getContexts](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/getContexts)、[MDN getViews](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/extension/getViews)、[MDN tabs.getCurrent](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/getCurrent)。実ブラウザの検証状況は [testing.md](testing.md) を参照してください。
