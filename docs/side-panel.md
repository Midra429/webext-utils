# side-panel

`webextSidePanel` は、Chrome の `sidePanel` と Firefox の `sidebarAction` を**同じ関数・同じ引数・同じ結果**で扱います。
ブラウザによって使える機能が異なる部分は、どちらでも同じ動作になる形に揃えています（[ブラウザ差の扱い](browser-differences.md#サイドパネル)）。

```ts
import { webextSidePanel } from '@midra/webext-utils/side-panel'
```

## 準備

Manifest にサイドパネルのページを指定します。

| ブラウザ | Manifest |
| --- | --- |
| Chrome | `"permissions": ["sidePanel"]` と `"side_panel": { "default_path": "panel.html" }` |
| Firefox | `"sidebar_action": { "default_panel": "panel.html", "default_title": "...", "open_at_install": false }` |

Firefox の `open_at_install` は既定で `true`（インストール時に自動で開く）です。Chrome と同じ動作にするため `false` を指定してください。

次の2つも登録してください。開閉状態の判定（`isOpen` / `toggle`）と開閉の通知（`onOpened` / `onClosed`）を、両ブラウザで同じ仕組みで動かすために必要です。

```ts
// background.ts（最上位で、最初の await より前に）
import { webextSidePanel } from '@midra/webext-utils/side-panel'

webextSidePanel.startBackground()
```

```ts
// panel.ts（サイドパネルとして表示するページ）
import { webextSidePanel } from '@midra/webext-utils/side-panel'

webextSidePanel.registerPanel()
```

## API

| API | 戻り値 | 説明 |
| --- | --- | --- |
| `open(options?)` | `Promise<void>` | 開く。既に開いていれば何もしない |
| `close(options?)` | `Promise<void>` | 閉じる。既に閉じていれば何もしない |
| `toggle(options?)` | `Promise<void>` | 開いていれば閉じ、閉じていれば開く |
| `isOpen(options?)` | `Promise<boolean>` | 開いているか |
| `setPage(path)` | `Promise<void>` | 表示するページを変更する（全ウィンドウ共通） |
| `getPage()` | `Promise<string>` | 表示するページの絶対 URL |
| `resetPage()` | `Promise<void>` | 表示するページを Manifest の既定値に戻す |
| `registerPanel()` | `Subscription` | パネル側のページで呼ぶ（開閉状態の判定・通知に必要） |
| `onOpened(listener)` | `Unsubscribe` | 開いたときの通知を受け取る |
| `onClosed(listener)` | `Unsubscribe` | 閉じたときの通知を受け取る |
| `startBackground(options?)` | `Unsubscribe` | Background で呼ぶ（開閉の通知・アイコンのクリックでの開閉） |

`options` は `{ windowId?: number }` です。省略すると、最後にフォーカスされたウィンドウ（ユーザーが操作しているウィンドウ）が対象です。

## 開く・閉じる

ブラウザは、**ユーザー操作（クリック・キーボードショートカット・コンテキストメニューなど）の処理内**でしか開閉を許可しません。
イベントハンドラーの中で、**`await` を挟まずに**呼び出してください。

```ts
document.querySelector('#toggle')?.addEventListener('click', () => {
  webextSidePanel.toggle().catch(console.error)
})
```

```ts
// NG: await の後では、ブラウザがユーザー操作の外と判断することがある
button.addEventListener('click', async () => {
  await somethingAsync()
  await webextSidePanel.open() // USER_GESTURE_REQUIRED になり得る
})
```

ユーザー操作の外で呼ぶと `USER_GESTURE_REQUIRED` で失敗します。

`open()` / `close()` / `toggle()` は、ブラウザに状態が反映されるのを待ってから完了します（最大 1 秒）。完了後の `isOpen()` は新しい状態を返します。

### Background から開閉する

Background では、イベントから得たウィンドウ ID を渡して呼び出します。

```ts
// background.ts
webextSidePanel.startBackground()

chrome.contextMenus.onClicked.addListener((_info, tab) => {
  if (tab) webextSidePanel.toggle({ windowId: tab.windowId }).catch(console.error)
})
```

`windowId` には、ユーザーが操作したウィンドウの ID を指定してください。Firefox はユーザーが操作中のウィンドウでしか開閉できないため、ライブラリは両ブラウザでこの前提のもとに同じ動作をします。

`toggle({ windowId })` を Background から呼ぶ場合は、`startBackground()` を登録しておくと、開閉の状態を同期的に判断してユーザー操作内で開閉できます。

### アイコンのクリックで開閉する

`openOnActionClick: true` を指定すると、ツールバーの拡張機能アイコンをクリックしたときにパネルを開閉します。

```ts
// background.ts
webextSidePanel.startBackground({
  openOnActionClick: true,
  onError: (error) => console.error(error), // 省略可
})
```

- Manifest の `action.default_popup` を設定している場合、クリックはポップアップを開くため動作しません（両ブラウザ共通）。
- 他の `action.onClicked` リスナーも引き続き呼ばれます。
- Background の起動ごとに登録が必要です（設定はブラウザに保存されません）。

## 開いているか確認する

```ts
const open = await webextSidePanel.isOpen() // 操作中のウィンドウ
const other = await webextSidePanel.isOpen({ windowId: 3 })
```

ユーザー操作は不要です。この拡張機能のパネルがそのウィンドウで開いているかを返します。
パネル側のページで `registerPanel()` を呼んでいない場合、開いていても `false` になることがあります（Chrome はブラウザ API からパネルのウィンドウを取得できないため）。

## ページを変更する

表示するページは、全体・ウィンドウごと・タブごとに設定できます。

```ts
// 全ウィンドウ共通
await webextSidePanel.setPage('panel.html?view=settings')

// ウィンドウ 3 だけ
await webextSidePanel.setPage('panel.html?view=window', { windowId: 3 })

// タブ 42 がアクティブなときだけ
await webextSidePanel.setPage('panel.html?view=tab', { tabId: 42 })

await webextSidePanel.getPage({ tabId: 42 }) // 'chrome-extension://<id>/panel.html?view=tab'
await webextSidePanel.resetPage({ tabId: 42 }) // タブの設定を削除
await webextSidePanel.resetPage() // 全体の設定を Manifest の既定値に戻す
```

| `target` | 意味 | `getPage(target)` の結果 |
| --- | --- | --- |
| 省略 | 全ウィンドウ共通 | 全体の設定 |
| `{ windowId }` | そのウィンドウのパネル | ウィンドウ > 全体 |
| `{ tabId }` | そのタブがアクティブなときのパネル | タブ > タブのウィンドウ > 全体 |

- 優先順位は「タブ > ウィンドウ > 全体」です。
- 開閉状態はどの設定でもウィンドウ単位です。タブを切り替えると、パネルは開いたまま、内容がそのタブのページに切り替わります。
- 相対パスは拡張機能のルートを基準に解決します。クエリとハッシュは保持します。
- この拡張機能以外の URL（Web ページ・他の拡張機能）は `INVALID_ARGUMENT` です。
- 開いているパネルにも反映されます。
- `getPage()` は設定値を返します。パネルが開いているかどうかは `isOpen()` で確認してください。

### ウィンドウ・タブごとのページの仕組みと条件

ブラウザには全体のページだけを設定し、ウィンドウ・タブごとのページへの切り替えは、パネルのページ（`registerPanel()`）がライブラリの記録を見て行います。
Chrome にはウィンドウごとの設定がなく、タブごとの設定では開閉状態までタブ単位になり Firefox と動作が異なるためです。

- **パネルに表示するすべてのページで `registerPanel()` を呼んでください。** 切り替え先のページで呼ばれていないと、以降の切り替えが止まります。
- Manifest に `storage` 権限が必要です（設定は `storage.session` に保存します）。
- 切り替えはページの遷移です。パネル内の状態（入力中の値など）は引き継がれません。必要なら storage や messaging で共有してください。
- パネルを開いた直後は、全体のページが読み込まれてから該当するページへ遷移します。
- 切り替えでは `onOpened` / `onClosed` は通知されません。`onClosed` の `page` は閉じた時点のページです。
- 閉じたタブ・ウィンドウの設定は、Background の `startBackground()` が削除します（登録がない場合も、ブラウザを閉じると消えます）。

## 開閉の通知を受け取る

Background の `startBackground()` とパネル側の `registerPanel()` を登録すると、開閉が `onOpened` / `onClosed` に通知されます。

```ts
// background.ts やポップアップなど
const stopOpened = webextSidePanel.onOpened(({ windowId, page }) => {
  console.log('opened', windowId, page)
})
const stopClosed = webextSidePanel.onClosed(({ windowId }) => {
  console.log('closed', windowId)
})

// 不要になったら解除する
stopOpened()
stopClosed()
```

| 通知 | タイミング |
| --- | --- |
| `onOpened` | パネルが開いたとき |
| `onClosed` | パネルが閉じたとき（閉じた・他のパネルに切り替えた・ウィンドウを閉じた） |

- 通知を受け取れるのは Background と拡張機能のページ（ポップアップ・タブ・サイドパネル）です。Content Script には届きません。
- 通知はリスナーの登録後に起きた開閉だけです。現在の状態は `isOpen()` で確認してください。
- `page` はパネルに表示されているページの絶対 URL です（クエリとハッシュを含みます）。
- 通知は Background が配信します。Background の登録がないと通知されません。

`registerPanel()` は1ページにつき1回です。戻り値を呼ぶと登録を解除します。`ready` はウィンドウを特定して登録が完了すると解決します。

## エラー

| コード | 原因 |
| --- | --- |
| `USER_GESTURE_REQUIRED` | ユーザー操作の外で開閉した |
| `UNSUPPORTED_OPERATION` | サイドパネルの API がない（Manifest の設定・権限を確認） |
| `CONTEXT_UNAVAILABLE` | 拡張機能の外で呼んだ、`startBackground()` を Background 以外で呼んだ、Manifest に既定ページがない |
| `INVALID_ARGUMENT` | 不正な `windowId`・ページ、二重登録 |
| `WINDOW_NOT_FOUND` | 指定したウィンドウが存在しない |
| `PERMISSION_DENIED` | 権限が不足している |
| `NATIVE_ERROR` | その他のブラウザ API の失敗（`cause` に元のエラー） |

## 提供しない機能

次の機能は、ブラウザの制約で両ブラウザの動作を揃えられないため提供していません。

- **タブごとの開閉状態**（Chrome の「タブ専用パネル」）: Firefox で再現するには、タブを切り替えた瞬間に開閉する必要があります。Firefox の開閉はユーザー操作の処理内でしか呼べず、タブの切り替えはユーザー操作として扱われないため実現できません。
- **アクティブでないウィンドウを指定した開閉**: Firefox の開閉はアクティブなウィンドウだけが対象です。先にウィンドウへフォーカスを移すと、その待ち時間でユーザー操作の扱いが失われます。
- **ユーザー操作を伴わない開閉**: どちらのブラウザも許可していません。

参考: [Chrome sidePanel](https://developer.chrome.com/docs/extensions/reference/api/sidePanel) / [Firefox sidebarAction](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/sidebarAction)
