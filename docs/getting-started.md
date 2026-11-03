# はじめに

このページでは、Chrome と Firefox の両方で動く拡張機能に `@midra/webext-utils` を組み込む手順を説明します。

## 1. Manifest を用意する

Manifest の書式だけはブラウザごとに異なります（ライブラリは Manifest を書き換えません）。
以下は、ポップアップ・サイドパネル・Content Script を持つ拡張機能の例です。

**Chrome** (`manifest.json`)

```json
{
  "manifest_version": 3,
  "name": "Example",
  "version": "1.0.0",
  "minimum_chrome_version": "142",
  "permissions": ["storage", "sidePanel"],
  "background": { "service_worker": "background.js" },
  "action": { "default_popup": "popup.html" },
  "side_panel": { "default_path": "panel.html" },
  "content_scripts": [
    { "matches": ["https://example.com/*"], "js": ["content.js"] }
  ]
}
```

**Firefox** (`manifest.json`)

```json
{
  "manifest_version": 3,
  "name": "Example",
  "version": "1.0.0",
  "browser_specific_settings": {
    "gecko": { "id": "example@example.com", "strict_min_version": "145.0" }
  },
  "permissions": ["storage"],
  "background": { "scripts": ["background.js"] },
  "action": { "default_popup": "popup.html" },
  "sidebar_action": {
    "default_panel": "panel.html",
    "default_title": "Example",
    "open_at_install": false
  },
  "content_scripts": [
    { "matches": ["https://example.com/*"], "js": ["content.js"] }
  ]
}
```

| 項目 | 理由 |
| --- | --- |
| `permissions: ["storage"]` | storage、受信ハンドラーの登録情報の保存、popout の管理に使います |
| Chrome の `sidePanel` 権限と `side_panel` | サイドパネルを使う場合に必要です |
| Firefox の `sidebar_action` | サイドパネル（サイドバー）を使う場合に必要です |
| `open_at_install: false` | Firefox はインストール直後にサイドバーを自動で開くため、Chrome と同じ動作にするには `false` を指定します |

タブの URL やタイトルを読む場合は `tabs` 権限か対象サイトのホスト権限を追加してください。

## 2. Background を初期化する

Background のスクリプトでは、使う機能の `startBackground()` を**最初の `await` より前に**呼び出します。
Chrome の Service Worker も Firefox のイベントページも停止・再起動するため、起動のたびに同じ登録が必要です（スクリプトの最上位に書けば自動的にそうなります）。

```ts
// background.ts
import {
  webextMessaging,
  webextPopout,
  webextSidePanel,
  webextStorage,
} from '@midra/webext-utils'

webextMessaging.startBackground() // メッセージの中継（他の機能より先に）
webextStorage.startBackground() // Content Script から storage を使う場合
webextPopout.startBackground() // popout を使う場合
webextSidePanel.startBackground() // サイドパネルを使う場合

// 受信ハンドラーも同期的に登録する
const messaging = webextMessaging<Messages>()
messaging.on('settings:get', async () => {
  return { theme: 'dark' }
})
```

| 登録 | 必要な場面 |
| --- | --- |
| `webextMessaging.startBackground()` | messaging を使う場合（storage・popout も内部で使用） |
| `webextStorage.startBackground()` | Content Script・MAIN world から storage を使う場合 |
| `webextPopout.startBackground()` | popout を使う場合 |
| `webextSidePanel.startBackground()` | サイドパネルを使う場合（開閉の通知・アイコンのクリックでの開閉） |

## 3. 型を共有する

メッセージとストレージの型は、各エントリーポイントで共有するファイルにまとめると便利です。

```ts
// shared.ts
export type Messages = {
  'settings:get': { data: void; response: { theme: 'light' | 'dark' } }
  'page:title': { data: void; response: string }
}

export type Schema = {
  'settings.theme': 'light' | 'dark'
  'settings.fontSize': number
}
```

メッセージの型はグローバル宣言（`WebextMessages`）にすることもできます。[messaging](messaging.md#型の定義) を参照してください。

## 4. 各ページで使う

### ポップアップ・サイドパネル・オプションページ

```ts
// popup.ts
import { webextMessaging, webextSidePanel, webextStorage } from '@midra/webext-utils'
import type { Messages, Schema } from './shared'

const messaging = webextMessaging<Messages>()
const settings = webextStorage<Schema>().namespace('settings')

const { theme } = await messaging.send('settings:get')
await settings.set('fontSize', 14)

document.querySelector('#panel')?.addEventListener('click', () => {
  // ユーザー操作の中で、await を挟まずに呼ぶ
  webextSidePanel.open().catch(console.error)
})
```

サイドパネルとして表示するページでは、開閉状態の判定と通知のために `registerPanel()` を呼びます。

```ts
// panel.ts
import { webextSidePanel } from '@midra/webext-utils/side-panel'

webextSidePanel.registerPanel()
```

オプションページは自動判定できないため、エントリーポイントで宣言します。

```ts
// options.ts
import { webextContext } from '@midra/webext-utils/context'

webextContext.register({ kind: 'options' })
```

### Content Script

```ts
// content.ts
import { webextMessaging, webextStorage } from '@midra/webext-utils'
import type { Messages, Schema } from './shared'

const messaging = webextMessaging<Messages>()
messaging.on('page:title', () => document.title)
await messaging.ready() // Background への登録完了を待つ

const theme = await webextStorage<Schema>().get('settings.theme')
```

Background や UI からは、タブ ID を指定して Content Script に送信できます。

```ts
const title = await messaging.send('page:title', undefined, {
  target: { context: 'content-script', tabId: 42 },
})
```

## 5. エラーを処理する

すべての失敗は `WebextError` で、`code` で原因を判別できます。

```ts
import { isWebextError } from '@midra/webext-utils'

try {
  await messaging.send('page:title', undefined, {
    target: { context: 'content-script', tabId },
  })
} catch (error) {
  if (isWebextError(error) && error.code === 'NO_RECEIVER') {
    // Content Script が注入されていない
  }
}
```

コードの一覧は [エラー](errors.md) を参照してください。

## 次に読む

- [messaging](messaging.md) / [storage](storage.md) / [side-panel](side-panel.md) / [popout](popout.md) / [context](context.md)
- Web ページ（MAIN world）と通信する場合: [MAIN world](main-world.md)
- 動く例: [examples](../examples/README.md)
