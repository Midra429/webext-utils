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

## 負荷の扱い

ブリッジには、要求の数やサイズに関する独自の上限はありません。ページ上の任意のスクリプトが要求を送れることを前提に、次の方法で拡張機能を守ります。

- **ページ由来の処理は document ごとに1件ずつ**: Background に届く処理（`fromPage` の送信、storage の操作、受信ハンドラーの登録）は、同じ document の要求を順番に1件ずつ実行します。チャネルが複数あっても同じ順番待ちを使います。大量に送られても、全タブで共有する Background に同時に届くのは1つの document（フレーム）につき1件だけで、待ち行列はそのページのプロセスに溜まります。
- **待ち時間も期限に含める**: 順番を待つ間に `timeoutMs`（既定 10 秒）を過ぎた要求は、Background に送らずに `TIMEOUT` で終わります。
- **Background に届くデータは共通の形式に従う**: 拡張機能の通信全体と同じく、JSON 互換・深さ 64・UTF-8 で 1 MiB までです。これを超える値は `SERIALIZATION_ERROR` です。ブリッジ内で受信したデータの解析・検査は、入れ子がどれだけ深くても処理できる方法で行います。

ISOLATED world と MAIN world の Content Script は、そのページと同じタブのプロセスで動きます。そのため、巨大なデータや大量の要求による解析・待機の負荷は、ページが自分で重い処理をした場合と同じく、そのタブの中にとどまります。

注意点:

- ページ由来の要求は並列に実行されません。時間のかかる要求を同時に複数送ると、後の要求はその分だけ待ちます。
- MAIN world の受信ハンドラーの中から別の要求を送って応答を待つと、待ちが循環して `TIMEOUT` になることがあります（外側の要求が終わるまで内側の要求が始まらないため）。
- `storage.sync` には、ブラウザ側に書き込み頻度の上限があります。ページに書き込みを公開すると、ページの連打で拡張機能全体の `sync` への保存が `QUOTA_EXCEEDED` になり得ます。ページに書き込みを公開するのは `local` / `session` 領域にしてください。

## セキュリティ上の注意

- `channel` はページから観測できます。認証や秘密には使えません。
- MAIN world からの送信は、受信ハンドラーで `sender.trust === 'page'` になります。特権的な処理の前に内容を検証してください。
- MAIN world に返すエラーは、コードと定型のメッセージだけです（内部の詳細は返しません）。
- ページ上の DOM イベントはユーザー操作の証明になりません（サイドパネルの開閉などには使えません）。
