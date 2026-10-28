# popout API

`@midra/webext-utils/popout`（rootからもexport）の `webextPopout` は、Action Popup / Side Panelと同じHTMLを独立したnative popup windowで開きます。Chrome142以降・Firefox145以降のデスクトップMV3を対象とします。

```ts
// Background入口。最初のawaitより前に同期登録する。
import { webextMessaging } from '@midra/webext-utils/messaging'
import { webextPopout } from '@midra/webext-utils/popout'

const stopRouter = webextMessaging.startBackground()
const stopPopout = webextPopout.startBackground()
```

```ts
// 元UIや他の拡張機能ページから。同じAPIをBackgroundからも使える。
const popout = await webextPopout.open({
  source: 'sidePanel',
  sourceTarget: { tabId: 42 },
  associatedTabId: 42,
  width: 480,
  height: 720,
  reuseKey: 'inspector-42',
})
console.log(popout.windowId, popout.bounds)
```

```ts
// 開いたHTML側。再読込やBackground再起動後も呼べる。
import { webextMessaging } from '@midra/webext-utils/messaging'
import { webextPopout } from '@midra/webext-utils/popout'

const current = await webextPopout.getCurrent()
if (current?.associatedTabId !== undefined && await current.tabExists()) {
  const tab = await current.getTab()
  await current.activateTab()
  const messaging = webextMessaging<{
    'page:title': { data: void; response: string }
  }>()
  const title = await messaging.send('page:title', undefined, {
    target: current.messageTarget(),
  })
  console.log(tab.id, title)
}
```

## API

| API | 結果と契約 |
| --- | --- |
| `open(options)` | `Promise<PopoutHandle>`。`source: 'popup' \| 'sidePanel'` 必須 |
| `getCurrent()` | 自分のnative tab/window、URL、記録が一致したhandle。それ以外は `undefined` |
| `get(windowId)` | 管理中の実在windowのhandle。未管理・削除済みは `undefined`。未知のAPI失敗はthrow |
| `close(windowId)` | 管理記録と生存windowを再照合して閉じる。未管理windowには副作用なし |
| `startBackground()` | 内部RPCとnative cleanupイベントを同期登録し、冪等な解除関数を返す。二重登録はエラー |

`PopoutOptions` は `source` のほか、`page`、排他的な `sourceTarget: {tabId} \| {windowId}`、`associatedTabId`、`width/height/left/top`、`focused`、`reuseKey`、`closeOriginal` を受け取ります。既定は480×720、位置未指定、focused=true、元UIを閉じない設定です。サイズは正の安全な整数、位置は負値も含む安全な整数です。

handleの情報は読み取り専用です。

| 情報・操作 | 契約 |
| --- | --- |
| `windowId/source/page/associatedTabId?/sourceTarget?/reuseKey?` | 当該windowと固定した関連付け。`page` は正規化した絶対URL |
| `bounds` | nativeが実際に返した位置・サイズ。OSによる調整を含む。再取得したhandleでは最新値 |
| `options` | 作成時の要求設定。pageと、windowから解決したsourceTargetは解決後の値 |
| `originalUiClose` | 今回のopenで元UIを閉じた結果。後のgetでは `not-requested` |
| `close()` | instance tokenも照合し、自分の管理windowだけを閉じる |
| `getTab()` | 固定した関連tabの最新情報。関連なしは `CONTEXT_UNAVAILABLE`、削除済みは `TAB_NOT_FOUND` |
| `tabExists()` | 関連なし・確定した削除だけfalse。権限不足・未知のnative失敗はthrow |
| `activateTab()` | tabをactiveにし、最新の所属windowをfocus。移動後も関連IDは変えない |
| `messageTarget({frameId?, documentId?, world?}?)` | messaging用content-script target。既定ISOLATED/frame0。documentId指定時はframeIdを強制しない |

`getTab()` の返り値 `PopoutTab` は基本的なID・windowId・index・active・pinnedと、optionalのurl/title/favIconUrlを持ちます。関連tabの切替追従はしません。メッセージ名・data・responseの型は既存messagingで検査します。

## ページ解決とブラウザ差

明示 `page` > nativeの有効設定 > native取得APIが存在しない場合だけManifest、の順です。nativeの空文字は「ページなし」、disabled panelは「無効」として `CONTEXT_UNAVAILABLE` を返します。権限エラーをManifest fallbackで隠しません。

- popupは `action.getPopup()`。Firefoxはtab/window設定を直接照会します。Chromeのwindow指定は、そのwindow内のactive tabを一度解決して照会し、採用したtabIdを記録します。
- sidePanelは既存の `webextSidePanel.getPage()` を使います。Chromeはwindow指定をactive tabに解決し、disabledも事前に検査します。設定を書き換えません。
- `sourceTarget` はページの取得元、`associatedTabId` は後で操作するtabです。省略してもactive tabとの関連付けは追加しません。
- 外部URL、別extension、ユーザー情報付きURL、javascript/data/blob、予約query `__webext_utils_popout` は拒否します。queryの値とhashを保持し、内部tokenをqueryに付けます。URLSearchParamsにより空白などの符号化表記は正規化されます。
- 元UIのManifest/action/sidebar設定は変更しません。同じHTMLの再読込なので、元UIのメモリ状態はコピーされません。共有状態にはstorage/messagingを使います。

同じ `reuseKey`・source・解決後page・関連tabに一致する生存windowをfocusして再利用します。同じkeyでこれらが違えば `INVALID_ARGUMENT` です。native設定が変わった場合も解決後pageを比較します。同じkeyの同時作成はWeb Lockで直列化します。boundsは再利用時に変更しません。keyなしは常に新規です。

## 記録と復元

Backgroundだけが `storage.session` の予約キーに書き込みます。pendingを保存し、window作成後にnative window ID・popout自身のtab IDをreadyへ確定します。関連tab IDとは別フィールドです。操作とcleanupは同じWeb Lockで直列化し、常時pollingはしません。

起動・読み取り時にnative window/tabと照合します。中断したpendingはURL・tokenが一意に一致するpopup windowだけを復旧し、複数一致は明示エラーにします。孤児、閉鎖、別URLへのnavigation、popout tabの別windowへの移動は管理を終了します。関連tabの削除は記録を消しません。

Firefoxの初期about:blank、Chromeの初期空URLがloading中なら最大40回×25msだけ再照会します。未完了なら記録を保持して `CONTEXT_UNAVAILABLE`。pageが一致する前に所有権を認めたり、loadingだけを理由に記録を削除したりしません。

ready保存失敗時は今回作ったwindowを削除して補償します。補償も失敗した場合は `NATIVE_ERROR` の `cause` と `details.windowId/details.compensation` に両方の失敗を含めます。内部RPCでもこの情報を運びます。session失敗をlocal保存に切り替えません。

拡張機能ページからの管理は既存messagingの内部RPCを使用し、Backgroundでnative senderの拡張機能ID・URL・trustを検証します。Content Script/MAIN/page bridgeには公開しません。コピーしたtokenだけでは自己tab/window照合を通過しません。同じ権限を持つ拡張機能コードを隔離する機構ではありません。

## 元UIを閉じる

`closeOriginal: true` は呼び出し元が元UIと確認できた場合だけ試みます。結果は作成成功と分けてhandleへ返します。

| `originalUiClose.status` | 意味 |
| --- | --- |
| `not-requested` | 要求なし |
| `closed` | popupのwindow.closed、または対応native closeの成功を確認 |
| `unsupported` | 呼び出し元を特定できない、別UI、対象scopeに非対応など |
| `failed` | close失敗。`error: WebextError` を参照。作成したpopoutは維持 |

Firefoxのsidebarはactive-window/gesture制約を持ち、作成await後には閉じられない場合があります。Chrome142–144のtab限定closeも非対応です。成功を装うためのページ設定変更や、他windowのAction Popupを閉じる処理はありません。元popup自体を閉じるとその呼び出し元のJavaScript寿命も終了するので、以後の状態取得は新しいpopout側で行ってください。

## cleanupの契機

Background開始時と明示的なopen/get/closeではsessionとnative windowを照合し、pendingの復旧も行います。稼働中は管理中のtab/window（またはpending）に関係する閉鎖・移動・URL/status変更だけを再照合し、タイトル変更や無関係なタブ更新では全件走査しません。連続イベントは実行中1件と追加照合要求に集約します。未知のnative失敗では記録を成功扱いで削除せず、次の照合で再確認します。

## Manifestと制約

```json
{
  "manifest_version": 3,
  "permissions": ["storage", "sidePanel"],
  "action": { "default_popup": "ui.html" },
  "side_panel": { "default_path": "panel.html" }
}
```

これはChromeの関連部分です。Firefoxでは `sidePanel` 権限と `side_panel` を外し、`sidebar_action: {"default_panel":"panel.html"}` とMV3 Background scriptsを指定します。popupだけの利用にはsidePanelの設定・権限は不要です。popout URLをweb_accessible_resourcesにする必要もありません。

sessionに `storage` 権限、管理にWeb Locksが必要です。関連tabのurl/title/favIconUrlの取得には `tabs` または該当host権限等が必要です。tabの基本操作すべてにtabs権限が必須という意味ではありません。

実測範囲は [検証結果](testing.md)。macOS以外・private browsing・Firefoxイベントページの実unload・作成途中の実強制停止は追加検証対象です。pending中断は保存状態の注入と新規manager復旧で検証しています。ブラウザセッションを越えるIDの復元や、途中のwindow作成のexactly-once実行は保証しません。

公式資料: [windows.create](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/windows/create)、[Chrome action.getPopup](https://developer.chrome.com/docs/extensions/reference/api/action#method-getPopup)、[Firefox action.getPopup](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/action/getPopup)。
