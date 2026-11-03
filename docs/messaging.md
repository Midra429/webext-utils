# messaging

`webextMessaging` は、Background・Content Script・拡張機能のページ（ポップアップ・サイドパネル・popout・タブ）の間で、型付きのメッセージを送受信します。

```ts
import { webextMessaging } from '@midra/webext-utils/messaging'
```

## 型の定義

メッセージは `{ data: 送信データ; response: 応答 }` の形で定義します。

```ts
type Messages = {
  'settings:get': { data: void; response: { theme: 'light' | 'dark' } }
  'tab:highlight': { data: { selector: string }; response: boolean }
  'ui:changed': { data: { theme: string }; response: void } // 通知
}

const messaging = webextMessaging<Messages>()
```

- `data` が `void`（または `undefined` を含む）なら、送信時にデータを省略できます。
- `response` が `void` のメッセージは `notify` / `notifyAll` で送れます。

型をすべてのファイルで共有する場合は、グローバルの `WebextMessages` を拡張します。型引数なしの `webextMessaging()` でも推論されます。

```ts
declare global {
  interface WebextMessages {
    'settings:get': { data: void; response: { theme: 'light' | 'dark' } }
  }
}

const messaging = webextMessaging() // WebextMessages の型を使う
```

型引数とグローバル宣言の両方がある場合は統合され、同じ名前は型引数が優先されます。

## 初期化

Background では、最初の `await` より前にルーターを開始し、受信ハンドラーを登録します。

```ts
// background.ts
webextMessaging.startBackground()

const messaging = webextMessaging<Messages>()
messaging.on('settings:get', async () => ({ theme: 'dark' }))
```

Background 以外で受信する場合は、登録後に `ready()` で Background への登録完了を待ってから、送信側に知らせてください。

```ts
// content.ts
const messaging = webextMessaging<Messages>()
messaging.on('tab:highlight', ({ selector }) => {
  return document.querySelector(selector) !== null
})
await messaging.ready()
```

Background 以外の受信には Manifest の `storage` 権限が必要です（Background の再起動後に受信先を復元するため）。

## API

| API | 説明 |
| --- | --- |
| `send(name, data?, options?)` | 送信して応答を受け取る |
| `notify(name, data?, options?)` | 応答のない通知を送る（受信側の処理完了を待つ） |
| `notifyAll(name, data, options)` | 宛先に一致するすべての受信側に通知し、配信結果を返す（`target` 必須） |
| `on(name, handler)` | 受信ハンドラーを登録する。解除関数を返す |
| `ready()` | 受信ハンドラーの登録完了を待つ |
| `installPageBridge(options)` | MAIN world に公開するブリッジを設置する（[MAIN world](main-world.md)） |
| `dispose()` | このクライアントのハンドラー・ブリッジ・待機中の処理をすべて解除する |
| `webextMessaging.startBackground()` | Background でルーターを開始する |

### `SendOptions`

| オプション | 既定値 | 説明 |
| --- | --- | --- |
| `target` | `{ context: 'background' }` | 宛先 |
| `timeoutMs` | `10000` | 応答を待つ時間（ミリ秒） |
| `ignoreMissing` | `false` | `true` なら受信側がないとき例外ではなく `{ delivered: false }` を返す |

```ts
const result = await messaging.send('settings:get', undefined, {
  ignoreMissing: true,
})
if (result.delivered) console.log(result.value.theme)
```

`ignoreMissing` が抑制するのは `NO_RECEIVER` だけです。タイムアウトやハンドラーの例外はそのまま投げます。

## 宛先

| 宛先 | 例 |
| --- | --- |
| Background | `{ context: 'background' }` |
| Content Script | `{ context: 'content-script', tabId, frameId?, world?, documentId? }` |
| 拡張機能のページ | `{ context: 'popup' \| 'side-panel' \| 'popout' \| 'options' \| 'extension-page' \| 'devtools', windowId?, tabId?, documentId? }` |

- 条件はすべて AND で照合します。
- Content Script の `world` の既定値は `ISOLATED`、`send` / `notify` の `frameId` の既定値は `0`（トップフレーム）です。`notifyAll` で `frameId` を省略すると全フレームに届きます。
- 一致する受信側がない場合は `NO_RECEIVER`、`send` / `notify` で複数一致した場合は送信前に `AMBIGUOUS_TARGET` です。

```ts
// サイドパネルに送る
await messaging.send('panel:refresh', undefined, {
  target: { context: 'side-panel', windowId },
})

// タブ内のすべてのフレームに通知する
const report = await messaging.notifyAll('ui:changed', { theme: 'dark' }, {
  target: { context: 'content-script', tabId },
})
for (const result of report.results) {
  if (!result.delivered) console.warn(result.instanceId, result.error.code)
}
```

## 送信元

受信ハンドラーの第2引数は送信元の情報（`MessageSender`）です。ブラウザが確認した値だけを含みます。

```ts
messaging.on('tab:highlight', (data, sender) => {
  sender.context // 'background' | 'content-script' | 'extension-page'
  sender.tabId // Content Script からの送信ならタブ ID
  sender.trust // 'extension' | 'page'（MAIN world からの送信は 'page'）
  return true
})
```

`trust: 'page'` の送信は Web ページと同じ信頼度です。権限の必要な処理を行う前に内容を検証してください。

## 送受信できるデータ

JSON 互換の値（有限の数値・文字列・真偽値・`null`・配列・プレーンオブジェクト）だけを扱います。

- トップレベルの `undefined` は「データなし」として送れます。
- `Date`・`Map`・`Set`・関数・循環参照・オブジェクト内の `undefined` などは `SERIALIZATION_ERROR` です（黙って変換しません）。
- 1メッセージは深さ 64、要素数 100,000、UTF-8 で 1 MiB までです。

## 寿命と再接続

- 1つの JavaScript 環境（ページ・Content Script）につき1本の接続を共有します。同じ名前のハンドラーは1つだけ登録できます。
- Background が停止・再起動しても、次の送信時に受信先を復元します。定期的な通信（heartbeat）はしません。
- 送信中に失われた要求は自動で再送しません。解除やタイムアウトは、既に始まった処理を取り消しません。
- ページを閉じるときは `dispose()` を呼ぶと、ハンドラーと待機中の処理をまとめて解除できます。

## エラー

| コード | 原因 |
| --- | --- |
| `NO_RECEIVER` | 宛先に一致する受信ハンドラーがない |
| `AMBIGUOUS_TARGET` | `send` / `notify` の宛先に複数一致した |
| `ROUTER_UNAVAILABLE` | Background で `startBackground()` していない |
| `TIMEOUT` | `timeoutMs` 内に応答がなかった |
| `TRANSPORT_CLOSED` | 接続が切れた、または解除・破棄された |
| `HANDLER_ERROR` | 受信ハンドラーが例外を投げた |
| `SERIALIZATION_ERROR` | JSON 互換ではないデータ |
| `CONTEXT_UNAVAILABLE` | 実行場所を特定できない（例: 判定前の popout） |

その他は [エラー](errors.md) を参照してください。
