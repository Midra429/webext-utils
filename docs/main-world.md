# MAIN world

MAIN world の Content Script は Web ページと同じ JavaScript 環境で動き、拡張機能 API を使えません。
このライブラリでは、ISOLATED world の Content Script が**公開を許可したメッセージとストレージのキーだけ**を、MAIN world から使えるようにします。

```text
MAIN world ──(CustomEvent)── ISOLATED world ──(拡張機能の通信)── Background / UI
            公開ポリシーで検査
```

MAIN world は Web ページと同じ信頼度です。ページ上の他のスクリプトも同じ操作を呼び出せるため、秘密情報や任意の操作を公開しないでください。

## ISOLATED world: ブリッジを設置する

```ts
// isolated.ts
import { webextMessaging } from '@midra/webext-utils/messaging'

type PublicMessages = {
  'page:title': { data: void; response: string }
  'ui:changed': { data: { theme: 'light' | 'dark' }; response: void }
}

const messaging = webextMessaging<PublicMessages>()
const bridge = messaging.installPageBridge({
  channel: 'my-extension-v1',
  allowedOrigins: ['https://example.com'],
  // MAIN world から送信できるメッセージ（宛先は固定）
  fromPage: {
    'ui:changed': {
      target: { context: 'background' },
      validateData: (v): v is { theme: 'light' | 'dark' } =>
        typeof v === 'object' && v !== null && 'theme' in v &&
        (v.theme === 'light' || v.theme === 'dark'),
      validateResponse: (v): v is void => v === undefined,
    },
  },
  // MAIN world で受信できるメッセージ
  toPage: {
    'page:title': {
      validateData: (v): v is void => v === undefined,
      validateResponse: (v): v is string => typeof v === 'string',
    },
  },
})
```

| オプション | 説明 |
| --- | --- |
| `channel` | 通信の識別子。MAIN world 側と同じ値にします（秘密情報ではありません） |
| `allowedOrigins` | ブリッジを有効にするページのオリジン（HTTP(S) のみ） |
| `fromPage` | MAIN world から送れるメッセージ。宛先 `target` と validator が必須 |
| `toPage` | MAIN world で受信できるメッセージ。validator が必須 |
| `limits` | 資源上限（下表） |

validator は型ガード関数です。`false` を返すか例外を投げると `VALIDATION_ERROR` になります。データがない場合（`void`）も `undefined` を検査してください。

ブリッジはページの破棄・BFCache を自動で処理します。不要になったら `bridge.dispose()`（または `messaging.dispose()`）で撤去します。

## MAIN world: ブリッジを使う

```ts
// main.ts（"world": "MAIN" の Content Script）
import { webextContext } from '@midra/webext-utils/context'
import { webextMessaging } from '@midra/webext-utils/messaging'

webextContext.register({ kind: 'content-script', world: 'MAIN' })

const messaging = webextMessaging<PublicMessages>({
  bridge: { channel: 'my-extension-v1' },
})

messaging.on('page:title', () => document.title)
await messaging.ready()
await messaging.notify('ui:changed', { theme: 'dark' })
```

MAIN world は自動判定できないため、`webextContext.register()` で宣言してください。

Background や UI から MAIN world のハンドラーに送るには、`world: 'MAIN'` を指定します。

```ts
await messaging.send('page:title', undefined, {
  target: { context: 'content-script', tabId, world: 'MAIN' },
})
```

## storage を公開する

ISOLATED world で、キーごとに読み込み・書き込み・監視を許可します。公開するすべてのキーに validator が必要です。

```ts
// isolated.ts
import { webextStorage } from '@midra/webext-utils/storage'

const settings = webextStorage<Schema>().namespace('settings')
const stopExpose = settings.exposeToPage(bridge, {
  read: ['theme', 'language'],
  write: ['theme'],
  watch: ['theme'], // watch には read も必要
  validate: {
    theme: (v): v is 'light' | 'dark' => v === 'light' || v === 'dark',
    language: (v): v is string => typeof v === 'string',
  },
})
```

```ts
// main.ts
const publicStorage = webextStorage<{
  'settings.theme': 'light' | 'dark'
  'settings.language': string
}>({ bridge: { channel: 'my-extension-v1' } })

await publicStorage.set('settings.theme', 'dark')
publicStorage.watch('settings.theme', ({ newValue }) => console.log(newValue))
```

- `write` は保存と削除を許可します。一括操作に未許可のキーが1つでもあれば、全体を拒否します。
- MAIN world から `migrate` はできません。
- BFCache から復帰したときは購読を再登録し、最新値との差分を通知します。

## 資源上限

| 上限 | 既定値 | 説明 |
| --- | --- | --- |
| `maxBytes` | 65536 | 1メッセージの最大バイト数（UTF-8） |
| `maxDepth` | 32 | JSON の最大の深さ（最大 64） |
| `maxPending` | 32 | 同時に処理中にできる要求数 |
| `requestsPerMinute` | 60 | ISOLATED world が受け付ける1分あたりの要求数 |

ISOLATED world は `installPageBridge({ limits })`、MAIN world は `webextMessaging({ bridge: { channel, limits } })` で設定します。送受信の両側の上限を満たす必要があります。

## セキュリティ上の注意

- `channel` はページから観測できます。認証や秘密には使えません。
- MAIN world からの送信は、受信ハンドラーで `sender.trust === 'page'` になります。特権的な処理の前に内容を検証してください。
- MAIN world に返すエラーは、コードと定型のメッセージだけです（内部の詳細は返しません）。
- ページ上の DOM イベントはユーザー操作の証明になりません（サイドパネルの開閉などには使えません）。
