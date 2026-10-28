# Storage API

`@midra/webext-utils/storage` はlocal / sync / sessionを明示的に選択する型付きstoreです。既定はlocal。Manifestには `"permissions": ["storage"]` が必要です。APIがない場合に別areaへ保存しません。factoryとnamespaceの生成だけではnative API・listener・通信を使いません。

```ts
import { webextStorage } from '@midra/webext-utils/storage'

type Schema = {
  'settings.theme': 'light' | 'dark'
  'settings.language': string
  'settings.notifications': boolean
  'settings.editor.fontSize': number
}
const storage = webextStorage<Schema>()
const settings = storage.namespace('settings')
await settings.set('theme', 'dark')
await settings.namespace('editor').set('fontSize', 16)
const pair = await settings.getMany(['theme', 'language'] as const)
// { theme: 'light' | 'dark' | undefined; language: string | undefined }
await settings.setMany({ theme: 'light', language: 'ja' })
```

| API | 戻り値・契約 |
| --- | --- |
| `webextStorage<S>({ area?, bridge?, validate? }?)` | `StorageClient<S>` |
| `get(key)` | `Promise<S[K] \| undefined>` |
| `getMany(keys)` | 全要求キーを持ち、未保存値はundefined。readonly tuple対応 |
| `set(key, value)` / `setMany(values)` | `Promise<void>`。JSON互換値のみ。batchの全キー・値を事前検査 |
| `remove(key)` / `removeMany(keys)` | `Promise<void>`。未保存でも成功 |
| `namespace(prefix)` | `prefix.`を外したキーを持つstore。保存キーは変更しない |
| `watch(key, callback, options?)` | oldValue / newValue、`StorageSubscription` |
| `watchAll(keys, callback, options?)` | 実行時に指定したキーだけの判別共用体、`StorageSubscription` |
| `watchAll(callback, options?)` | namespace内の任意キー。keyはstring、oldValue/newValueはunknown |
| `migrate(plan)` | `{ fromVersion, toVersion, applied }`。詳細は [移行ガイド](migrations.md) |
| `webextStorage.startBackground(options?)` | Content Script用RPCを同期登録し、解除関数を返す |
| `exposeToPage(bridge, policy)` | ISOLATEDでMAINへの権限を登録し、解除関数を返す |

キーはドットで区切る非空文字列です。空segment、先頭/末尾のドット、`__webext_utils`で始まるsegment、prototype関連の `__proto__` / `constructor` / `prototype` segmentは拒否します。`settings`は`settingsExtra`に一致しません。内部metadataはCRUD・watch・page公開から隠します。`clear`・`setAccessLevel`は公開しません。

スキーマはTypeScript上の制約です。batchの余分なキーは変数経由でも型エラーになりますが、型は実行時には消えます。型チェックを迂回した任意キーをスキーマから推測して拒否することはできません。ランタイムではキー構文とJSONを検証し、個別の値を検査するにはkey別parserを指定します。parserは同期関数で、検証したJSON値を返し、失敗時にthrowしてください。namespace利用時もparserのキーはfactory時のfull keyです。

```ts
const storage = webextStorage<Schema>({
  validate: {
    'settings.theme': value => {
      if (value !== 'light' && value !== 'dark') throw Error('Invalid theme')
      return value
    },
  },
})
```

parserはget・set・watchに適用します。失敗はget/setで `VALIDATION_ERROR`、watchではその不正イベントを配信しません。移行draftは旧データを扱うため、現在のparserを適用しません。

## BackgroundとContent Script

Background入口の最初のawaitより前に両方を登録します。

```ts
import { webextMessaging } from '@midra/webext-utils/messaging'
import { webextStorage } from '@midra/webext-utils/storage'

const stopRouter = webextMessaging.startBackground()
const stopStorage = webextStorage.startBackground({
  contentScriptAccess: { local: true, sync: true, session: false },
})
```

local/syncは既定で許可、sessionは明示的なtrueが必要です。`setAccessLevel`でarea全体を開放することはありません。利用側が設定済みのnative access levelも変更しません。

拡張機能ページとBackgroundはnative APIを直接使い、area単位のWeb Lockを共有します。Content ScriptのCRUDは同じロックに参加するBackground RPCを通します。Content Script自身のページoriginのロックは使いません。移行中に別contextから届くRPCはロック待ちになります。ルーターがなければ `ROUTER_UNAVAILABLE`、areaが非公開なら `ACCESS_DENIED` です。

監視はrealmごとにnative `storage.onChanged` を参照共有し、最後の購読解除でlistenerを外します。Background RPCを登録している間は配送用listenerが1件残ります。JSONオブジェクトのプロパティ順に依存せず同値を判定し、Firefoxで届き得るno-opを除外します。ローカル疑似イベントは重ねて発生させません。

```ts
const stop = settings.watch('theme', ({ oldValue, newValue }) => {
  console.log(oldValue, newValue) // 削除・未保存はundefined
}, { onError: error => console.error(error.code, error.message) })
await stop.ready // この購読の登録完了。失敗はWebextErrorでreject
const initial = await settings.get('theme') // 購読登録を先に行う
// 入口の終了時
stop()
```

watchは初期値を即時発火しません。戻り値は従来どおり呼び出して解除でき、`ready: Promise<void>`を持ちます。directのreadyはnative listener設置後、RPCはsessionへの購読保存後、MAINはホスト側のRPC登録と初期snapshot取得後に解決します。CRUD成功は購読成功の証拠になりません。登録中の解除ではreadyが`TRANSPORT_CLOSED`でrejectします。失敗・解除はリスナーと遅れて受理された購読を解放します。

`options.onError`は登録・再登録の失敗を通知します。`QUOTA_EXCEEDED`、`PERMISSION_DENIED`、`ACCESS_DENIED`、`ROUTER_UNAVAILABLE`、`TIMEOUT`、`TRANSPORT_CLOSED`等のcodeで判別できます。ルーター不在で受信Port登録が切断される場合は`TRANSPORT_CLOSED`です。再登録失敗時はその購読を停止するので、原因解消後に新しくwatchしてください。readyは最初の登録だけを表し、再接続時のエラーはonErrorで監視します。引数・context・native listener設置時の同期エラーは従来どおりthrowします。初期snapshotとイベントは原子的ではないため、厳密な状態には利用側でrevisionを管理してください。

型付きnamespace監視では、実行時にもキーを渡してください。

```ts
const stop = settings.watchAll(['theme', 'notifications'], change => {
  if (change.key === 'notifications') {
    console.log(change.newValue) // boolean | undefined
  } else {
    console.log(change.newValue) // 'light' | 'dark' | undefined
  }
}, { onError: console.error })
await stop.ready
```

キーを省略する`watchAll(callback)`は別スキーマや旧版のキーも監視するため、値はunknownです。これは従来の狭い型からの破壊的な型変更です。スキーマの型引数から実行時のキーは得られません。指定キーの値そのものを旧データ・別writerからも保証するには、既存のkey別parserを併用してください。

Content Scriptの受信登録と購読descriptorはsessionへ保存します。Background再起動後はnativeイベント配送時に既存messagingの再接続機構で復元し、idle heartbeatは使いません。タブ閉鎖は該当tabの記録を削除し、navigation完了やPort切断時は該当文書の受信先を確認してNO_RECEIVERの記録だけを削除します。Port切断自体は失効の証拠にしません。登録上限到達時にも失効確認を行い、生存購読だけで1,024件ならQUOTA_EXCEEDEDを返します。MAINはBFCache復帰・ブリッジ切断後に購読を再登録し、最新snapshotとの差分を通知します。切断期間の全履歴・exactly-onceは保証しません。復帰時には必要に応じてgetで再取得してください。

## MAINへの公開

MAINはページと同じ権限・信頼度です。チャネル名は秘密や認証にはなりません。ISOLATEDで作成した既存bridgeへ明示的に公開します。

```ts
const bridge = messaging.installPageBridge({
  channel: 'public-v1',
  allowedOrigins: ['https://example.com'],
  fromPage: {},
  toPage: {},
})
const stopExposure = settings.exposeToPage(bridge, {
  read: ['theme', 'language'], write: ['theme'], watch: ['theme'],
  validate: {
    theme: (v): v is 'light' | 'dark' => v === 'light' || v === 'dark',
    language: (v): v is string => typeof v === 'string',
  },
})
```

```ts
// MAIN: 公開キーだけの型を指定する
const publicStorage = webextStorage<{
  'settings.theme': 'light' | 'dark'
  'settings.language': string
}>({ bridge: { channel: 'public-v1' } })
await publicStorage.set('settings.theme', 'dark')
```

read / write / watchはarea・full key・操作で照合します。writeにはsetとremoveを含みます。watchにはreadも必要です。全公開キーのvalidatorが必須で、読み出し値・変更通知のold/new値も検査します。removeは旧値validatorを実行せずキー権限だけを検査します。batchに未許可キーが一つでもあれば変更前に全体を拒否します。

MAINのキー省略watchAllはnamespace内のwatch許可キーだけを展開し、型はstring/unknownです。キー指定watchAllは全指定キーのwatch/read権限が必要です。許可キーがない監視や未許可キーはreadyがACCESS_DENIEDでrejectします。複数の露出を同じbridgeへ登録できますが、同じareaの同じキーが重複する露出は拒否します。解除で該当の購読も停止し、bridgeのdispose/pagehideで購読を解放します。storageとmessagingは同じCustomEvent通信路・サイズ/並列/毎分制限・request多重化を共有します。messagingからstorage実装への依存はありません。

ネイティブのquota判定はAPIに委ねます。既知のquota違反は `QUOTA_EXCEEDED`、権限問題は `PERMISSION_DENIED`、不明な失敗はcause付き `NATIVE_ERROR`。session非対応やWeb Locks利用不可は `UNSUPPORTED_OPERATION` です。[Chrome Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)、[Firefox onChanged](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/onChanged)、[Web Locks API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API) も参照してください。

## Firefox sessionの既知のキー制約

Firefox156.0.1では名前空間なしの `toString` キーがnative getの結果から欠落します。`settings.toString` のようなドット付きnamespaceを使用してください。local/syncとChromeでは同じ試験が成功しています。ライブラリ内の継承プロパティ誤読は修正済みですが、このnative由来の失敗は回帰fixtureで検出し続けています。[検証結果](testing.md)を参照してください。
