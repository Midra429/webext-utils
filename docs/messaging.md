# webextMessaging

段階C/Dの実装です。Chrome / Firefox MV3のコンテキスト間で、JSON互換データを単一の登録済み宛先へ送ります。MAINはISOLATEDで明示的な公開ポリシーを持つブリッジを設置して利用します。[MAIN worldガイド](main-world.md) を参照してください。実機検証状況は [testing.md](testing.md) を参照してください。

## 初期化

Background入口では、最初のawaitより前にルーターとハンドラーを登録します。importや通常factory作成だけではlistener・Portは増えません。bridge指定のMAIN factoryは明示的にDOM通信listenerを登録します。

```ts
import { webextMessaging } from '@midra/webext-utils/messaging'

declare global {
  interface WebextMessages {
    'settings:get': { data: void; response: { theme: 'light' | 'dark' } }
    'page:title': { data: void; response: string }
    'ui:changed': { data: { theme: string }; response: void }
  }
}

const stopRouter = webextMessaging.startBackground()
const messaging = webextMessaging()
const stop = messaging.on('settings:get', () => ({ theme: 'dark' }))
```

受信viewは `webextContext.resolve()`、または既知の入口での `webextContext.register()` により役割を確定させてからハンドラーを登録できます。同期判定で既知のコンテキストなら、追加初期化は不要です。`unknown` のままの操作は `CONTEXT_UNAVAILABLE` です。

```ts
const messaging = webextMessaging()
const stop = messaging.on('page:title', () => document.title)
await messaging.ready()

const settings = await messaging.send('settings:get')
const title = await messaging.send('page:title', undefined, {
  target: { context: 'content-script', tabId: 42, frameId: 0 },
})
```

Background宛てだけなら `storage` 権限や常設Portは不要です。受信view・Content Scriptを登録する場合は、ルーターが `storage.session` に復旧用メタデータを保存するため、Manifestの `permissions: ['storage']` が必要です。session領域をContent Scriptへ開放する必要はありません。

storageをContent ScriptやMAINから使う場合は、このルーター登録に続けて `webextStorage.startBackground()` を同期登録します。storageのRPC/監視は内部の予約メッセージ名を使用し、利用側の `WebextMessages` への追加は不要です。MAINのstorageは同じブリッジ通信路を共有し、ISOLATEDの `exposeToPage` でキー別に制限します。使用例は [storage API](storage.md)、検証範囲は [検証結果](testing.md) を参照してください。

## 型とAPI

`webextMessaging<Override = {}>()` の有効な型は `Omit<WebextMessages, keyof Override> & Override` です。同名キーだけを置換し、グローバル専用キーは残します。グローバルが空なら任意名へは拡張しません。dataがvoidまたはundefinedを含む場合だけデータ引数を省略できます。

| API | 契約 |
| --- | --- |
| `send(name, data?, options?)` | `Promise<Response>`。target省略はBackground、timeoutMs既定10,000 |
| `notify(name, data?, options?)` | responseがvoidの名前だけ。ハンドラー完了ACKを待つ |
| `notifyAll(name, data, options)` | 明示target必須。dataなしはundefinedを渡す。各instanceのdelivered/errorを含む `{ results }` を返す |
| `on(name, handler)` | `(data, sender) => Response \| Promise<Response>`。解除関数を返す |
| `installPageBridge(options)` | ISOLATED専用。双方向ポリシーとvalidatorで公開操作を限定する `PageBridge` を返す |
| `ready()` | 現在の登録の保存・ACKを待つ。解除後に呼べばsession削除とPort解放まで待てる |
| `dispose()` | clientのハンドラー、実行中の受信待機、送信・readyの待機を解除。再利用不可 |
| `startBackground()` | 同期的にルーターlistenerを登録。二重起動を拒否し、解除関数を返す |

1つのrealmにある全factoryで、同名ハンドラーの二重登録を拒否します。clientのdisposeは別clientの登録を削除しません。解除やtimeoutは既に実行した副作用を取り消しません。最後の解除後の登録削除失敗は `ready()` で観測でき、残ったsession候補は次回の検証時に削除されます。

`ignoreMissing: true` は `{ delivered: true, value: Response } | { delivered: false }` を返します。正常なvoid応答でも `delivered: true` です。false・省略時はResponse、boolean変数の場合はResponseとDeliveryのunionになります。抑制するのは `NO_RECEIVER` だけです。

## 宛先と送信元

- Background: `{ context: 'background' }`
- Content Script: `{ context: 'content-script', tabId, world?, frameId?, documentId?, instanceId? }`。world既定ISOLATED、単一送信のframeId既定0。notifyAllでframeId省略時は全登録frameに一致します。
- view: `{ context: 'popup' | 'side-panel' | 'popout' | 'options' | 'extension-page' | 'devtools', windowId?, tabId?, documentId?, instanceId? }`

すべての条件はANDです。tabIdは物理的所属であり、popoutの関連タブではありません。0件は `NO_RECEIVER`、単一送信で2件以上は配送前に `AMBIGUOUS_TARGET`。選定後の切断・購読消失は `TRANSPORT_CLOSED` です。notifyAllは各宛先の失敗をreportへ残し、0件は `NO_RECEIVER` になります。

handlerのsenderにはネイティブから得た拡張機能id、確認できたtabId/frameId/windowId/documentId/url、および大分類context、`trust: 'extension' | 'page'` を渡します。viewの細かい役割ラベルは権限証明には使いません。payloadの自己申告でネイティブ送信元を上書きしません。window等の絞り込みに使う値もnative sender / documentIdで照合したgetContextsから取得します。tabに属する受信先は登録・再接続時とwindowIdによる配送先照合の直前にtabs.getで最新の所属を確認し、sessionにも反映します。別windowへ移動したタブには旧window宛てで配送しません。tabId/documentId/instanceId等とのAND条件は維持します。

## データとエラー

有限number、string、boolean、null、plain object、密なarrayを扱います。トップレベルのundefinedは値なしenvelopeで表します。内部undefined、Date/Map/Set/BigInt/関数、accessor、symbol、循環、疎配列を黙って変換しません。境界のJSONは深さ64、走査100,000値、UTF-8で1MiB以内です。envelopeの追加分も上限に含まれます。

主なエラーは `NO_RECEIVER`、`AMBIGUOUS_TARGET`、`ROUTER_UNAVAILABLE`、`TIMEOUT`、`TRANSPORT_CLOSED`、`HANDLER_ERROR`、`SERIALIZATION_ERROR`、`VALIDATION_ERROR` です。handlerのsync throw / async rejectは常に `HANDLER_ERROR` へ変換します。nativeエラーを特定できない場合はcauseを保持した `NATIVE_ERROR` です。wireにはcode/messageだけを返し、stack/causeを送りません。

## 再接続と寿命

受信realmにつき1本のPortを共有し、要求IDで多重化します。Background宛て送信はruntime.sendMessage、同じBackground内は同じ検証を通したローカル配送です。Content Scriptへの業務配送もPort経由です。tabs.sendMessageは復旧時の文書・instance限定制御に使います。

session記録にはinstance ID・世代・名前・native識別情報だけを保存します。payload、関数、未完了要求は保存しません。messaging単独では切断直後に再接続せず、次のsend/ready/配送用の再接続制御を契機にだけ再登録します。storage Backgroundを併用する場合は、文書失効確認の空通知もこの制御を使います。SW停止で中断された失効確認を新しいBackgroundへ持ち越しません。明示的な復旧は最大3試行（待機0/25/100ms）、要求期限内です。heartbeat・定期探索はありません。

再起動したルーターは全保存候補に制御メッセージを送り、ACKと再登録を確認してから件数を決定します。不在が確認できた候補だけを削除し、確認時のtimeout・権限異常は配送失敗として伝えます。制御には業務payloadを含めません。実行中に失われた要求は自動再送せず、exactly-onceは保証しません。

実装根拠: [Chrome Message passing](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)、[MDN runtime.onMessage](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/onMessage)、[MDN runtime.Port](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/Port)。onMessageは対象メッセージだけ非同期処理へ進み、非async listenerの `return true` とsendResponseを使います。
