# 公開API索引

5モジュールはrootまたはサブパスからnamed importできます。ESM専用、実行時依存なし。生成宣言はChrome / Firefox / Bun / DOMのambient型を要求しません。ブラウザ操作そのものには対応する拡張機能contextが必要です。

| import | 公開名 | 操作・参照 |
| --- | --- | --- |
| `/context` | `webextContext` | [`get`, `resolve`, `register`](context.md) |
| `/messaging` | `webextMessaging<M>()` | [`send`, `notify`, `notifyAll`, `on`, `ready`, `dispose`, `installPageBridge`, `startBackground`](messaging.md) |
| `/storage` | `webextStorage<S>()` | [`get`, `getMany`, `set`, `setMany`, `remove`, `removeMany`, `namespace`, `watch`, `watchAll`, `migrate`, `exposeToPage`, `startBackground`](storage.md) |
| `/sidePanel` | `webextSidePanel` | [`open`, `close`, `setPage`, `getPage`, `getState`, `onOpened`, `onClosed`, `getCapabilities`](side-panel.md) |
| `/popout` | `webextPopout` | [`open`, `getCurrent`, `get`, `close`, `startBackground`、handleの関連tab操作](popout.md) |

型・引数・戻り値・解除と失敗条件はリンク先の各API表を参照してください。rootでは各モジュールの公開型も再exportします。`webextMessaging` のグローバル `WebextMessages` 宣言と明示型による同名上書きは [型の定義](messaging.md)、MAINのvalidator必須policyは [MAINガイド](main-world.md) にあります。

`watch` / `watchAll`の戻り値は呼び出し可能な`StorageSubscription`です。`await subscription.ready`で登録結果を確認し、`options.onError`で再登録失敗も観測します。型付きの全監視には`watchAll(keys, callback)`を使い、キー省略ではstring/unknownを受け取ります。

## 初期化と寿命

| 入口 | 必要な処理 |
| --- | --- |
| Background | 最初のawait前にmessaging router、必要ならstorage / popoutのBackground登録。再起動ごとに同じ登録を行う |
| 通常のUI | 必要なfactoryを生成。受信時は `on` に続き `await ready()`、終了時は解除 / `dispose()` |
| popoutと共用するHTML | `await webextPopout.getCurrent()`、`await webextContext.resolve()` 後に受信登録。未照合tokenの間はunknown |
| ISOLATED | 必要なら `installPageBridge` とstorageキーACL。ネイティブsenderに基づく固定宛先とvalidator |
| MAIN | contextの明示登録と `bridge: { channel }`。公開済み操作だけ利用 |

`on` / watch / Background登録は解除関数を返します。解除は冪等です。messagingの `dispose()` 後はそのclientを再利用できません。storageには `dispose` はなく、watch / exposeの解除関数で解放します。importやfactory生成だけではnative listener・Portを作りません。

## 共通エラー

各サブパスから `WebextError` / `isWebextError` / `ErrorCode` をimportできます。`WebextError` は `code`、`operation`、任意の `cause` / `details` を持ちます。異なるrealmを越えるエラーは通信境界で再構築されます。

| code | 対応 |
| --- | --- |
| `UNSUPPORTED_OPERATION`, `CONTEXT_UNAVAILABLE` | capability / 実行場所を確認 |
| `PERMISSION_DENIED`, `USER_GESTURE_REQUIRED` | Manifestと呼び出し元のユーザー操作を確認 |
| `NO_RECEIVER`, `AMBIGUOUS_TARGET` | handlerの登録完了・単一宛先を確認 |
| `TIMEOUT`, `TRANSPORT_CLOSED`, `ROUTER_UNAVAILABLE` | 接続とBackground登録を確認。副作用のある要求を自動再送しない |
| `INVALID_ARGUMENT`, `SERIALIZATION_ERROR`, `VALIDATION_ERROR`, `ACCESS_DENIED` | 入力・JSON互換性・validator・公開policyを修正 |
| `HANDLER_ERROR` | 受信handlerの失敗。`ignoreMissing` で抑制しない |
| `MIGRATION_FAILED`, `SCHEMA_TOO_NEW`, `MIGRATION_CONFLICT` | [journalと復旧手順](migrations.md) を確認 |
| `TAB_NOT_FOUND`, `WINDOW_NOT_FOUND` | 対象の消失を処理 |
| `QUOTA_EXCEEDED`, `NATIVE_ERROR` | 容量やnativeのcauseを確認 |

`ignoreMissing: true` は確認できた受信側不在だけを `{ delivered: false }` に変換します。timeoutや権限不足を成功扱いにはしません。MAINへ内部cause・stack・秘密を公開しません。

実行可能な入口例は [examples](../examples/README.md)、Manifestと差分は [互換性](compatibility.md)、組み合わせは [統合ガイド](integration.md) を参照してください。
