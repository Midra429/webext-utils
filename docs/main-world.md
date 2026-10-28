# MAIN worldブリッジ

`installPageBridge()` はISOLATEDのContent Scriptから明示的に公開します。同じframeのdocument上で、JSON文字列をdetailに持つCustomEventを双方向に使います。Backgroundには通常のmessagingルーターが必要です。受信先の復旧メタデータを保存するため、Manifestに `storage` 権限を指定します。

```ts
// ISOLATED。Manifestのmatchesも対象サイトに限定する。
import { webextMessaging } from '@midra/webext-utils/messaging'

type PublicMessages = {
  'page:title': { data: void; response: string }
  'ui:changed': { data: { theme: 'light' | 'dark' }; response: void }
}

const messaging = webextMessaging<PublicMessages>()
const bridge = messaging.installPageBridge({
  channel: 'my-extension-public-v1',
  allowedOrigins: ['https://example.com'],
  fromPage: {
    'ui:changed': {
      target: { context: 'background' },
      validateData: (v: unknown): v is { theme: 'light' | 'dark' } =>
        typeof v === 'object' && v !== null && 'theme' in v &&
        (v.theme === 'light' || v.theme === 'dark'),
      validateResponse: (v: unknown): v is void => v === undefined,
    },
  },
  toPage: {
    'page:title': {
      validateData: (v: unknown): v is void => v === undefined,
      validateResponse: (v: unknown): v is string => typeof v === 'string',
    },
  },
})
// 入口の終了時。messaging.dispose()でも所有するbridgeを破棄する。
bridge.dispose()
```

```ts
// MAIN。同じPublicMessages型を共有する。
const messaging = webextMessaging<PublicMessages>({
  bridge: { channel: 'my-extension-public-v1' },
})
const stop = messaging.on('page:title', () => document.title)
await messaging.ready()
await messaging.notify('ui:changed', { theme: 'dark' })
stop()
await messaging.ready() // 代理受信先の登録解除を確認
messaging.dispose()
```

MAIN宛ては通常の `send('page:title', undefined, { target: { context: 'content-script', world: 'MAIN', tabId, frameId: 0 } })` で送ります。ISOLATEDの代理endpointがMAINのハンドラー名を登録し、ネイティブで確認したtab/frame/document情報に基づいて配送します。ISOLATED自身のハンドラーと同名でもworldで区別されます。MAINクライアントはチャネルごとに通信を共有し、同じdocumentのMAINで同名ハンドラーの二重登録を拒否します。

`fromPage` / `toPage` は要求を開始する方向です。両方ともdataとresponseのvalidatorが必須で、voidもundefinedを検証します。validatorのfalseや例外は `VALIDATION_ERROR`。MAINから送れる名前・宛先は `fromPage` で固定され、targetを明示する場合も全条件が一致する必要があります。Content Scriptの省略worldはISOLATED、frameIdは0として比較します。MAINからのnotifyAll、任意sender、内部名、未知field、許可されないハンドラー名を拒否します。型宣言だけでは実行時の公開権限は増えません。

ISOLATEDは実際のlocationと実行環境のoriginを照合します。HTTP(S)の正規化したoriginを完全一致で比較し、opaque/sandboxの `null`、file、data、別originを拒否します。payloadにoriginを書いても採用しません。設定はインストール時にコピーし、後からtargetや許可表を書き換えて権限を広げることはできません。

受信handlerの `sender.trust` は `page` または `extension` です。ページ開始要求では `page` とネイティブsender情報をルーターが付与します。ページの自己申告でid/tab/frame/documentを置換できません。特権処理がページ由来の入力を許すかは、handler側でも判断してください。

## 上限と寿命

既定上限は、envelopeを含む1メッセージがUTF-8で64KiB、深さ32、方向を合わせた未完了32件、ISOLATED側で1documentにつき60要求/分です。handshake・登録変更・closeも要求数に含み、複数チャネルで共有します。ID再利用を拒否し、1世代のID履歴は65,536件で上限になります。巨大JSONはparse前に文字数とUTF-8サイズを検査し、prototype/constructor等のキーを拒否します。未相関の不正イベントは無応答で破棄します。

ISOLATEDの `installPageBridge({ limits: { maxBytes, maxDepth, maxPending, requestsPerMinute } })` とMAINの `webextMessaging({ bridge: { channel, limits: { ... } } })` で上限を設定できます。正の整数、各値は最大1,048,576、深さは最大64です。送受信それぞれの上限を通る必要があり、ISOLATEDの上限をMAINから変更できません。同一MAINチャネルの明示設定は一致させます。タイムアウトは通常のmessaging同様に既定10秒です。

dispose・通常navigationのpagehideでpending、DOM listener、代理登録を解除します。BFCacheへのpagehideでは通信listenerとpendingを解除して復帰待ちのlifecycle listenerだけ残し、persisted pageshowで新世代handshakeを開始します。古い応答は新世代へ適用しません。代理endpointも通常のルーター再接続制御に対応し、idle切断だけではBackgroundを起こし続けません。timeoutや解除は既に始まった副作用を取り消しません。

## 公開通信の制約

channel・ID・応答はページから観測・偽造できます。MAINコードと同じページの別スクリプトを認証し分けることはできません。response validatorが成功しても、ページが作った値であることは変わらず、シークレットの通信や特権実行の承認に使えません。エラーは安全なcodeと定型messageだけをpageへ返します。DOMイベントをユーザー操作の証明として扱わず、user activationの転送も保証しません。

Firefoxでは非stringのCustomEvent.detailをworld間で共有するとアクセス制約があるため、detailをJSON文字列に限定しています。[MDN CustomEvent](https://developer.mozilla.org/en-US/docs/Web/API/CustomEvent) を参照してください。実ブラウザの合否と未検証範囲は [検証結果](testing.md) に記録しています。storageのpage公開は段階Eで実装済みです。

## Storage公開（段階E）

`storage.exposeToPage(bridge, policy)` で既存bridgeへarea・full key・read/write/watch別の権限を追加できます。全公開キーのvalidatorが必須です。MAINの `webextStorage({ bridge: { channel } })` は同じCustomEvent通信路を共有し、migrateや内部metadataを公開しません。使用例・購読解除・batch拒否・復帰時snapshotは [storage API](storage.md) を参照してください。
