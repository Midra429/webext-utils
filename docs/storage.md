# storage

`webextStorage` は、`storage.local` / `sync` / `session` を型付きで読み書きし、変更を監視します。バージョン付きのデータ移行もできます。

```ts
import { webextStorage } from '@midra/webext-utils/storage'
```

Manifest に `"permissions": ["storage"]` が必要です。

## 基本

スキーマの型を渡してクライアントを作ります。キーはドット区切りで階層化できます。

```ts
type Schema = {
  'settings.theme': 'light' | 'dark'
  'settings.language': string
  'settings.editor.fontSize': number
}

const storage = webextStorage<Schema>()

await storage.set('settings.theme', 'dark')
const theme = await storage.get('settings.theme') // 'light' | 'dark' | undefined
await storage.remove('settings.theme')
```

### namespace

`namespace(prefix)` で、プレフィックス配下だけを扱うクライアントを作れます。保存されるキーは変わりません。

```ts
const settings = storage.namespace('settings')
await settings.set('theme', 'dark') // 'settings.theme' に保存
await settings.namespace('editor').set('fontSize', 16) // 'settings.editor.fontSize'

const { theme, language } = await settings.getMany(['theme', 'language'])
await settings.setMany({ theme: 'light', language: 'ja' })
```

## API

| API | 説明 |
| --- | --- |
| `webextStorage<S>(options?)` | クライアントを作る（ブラウザ API にはまだ触れない） |
| `get(key)` / `getMany(keys)` | 読む。未保存は `undefined` |
| `set(key, value)` / `setMany(values)` | 保存する。一括保存はすべての値を検査してから書き込む |
| `remove(key)` / `removeMany(keys)` | 削除する。未保存でも成功 |
| `namespace(prefix)` | プレフィックス配下のクライアント |
| `watch(key, callback, options?)` | 1つのキーの変更を監視する |
| `watchAll(keys, callback, options?)` | 複数のキーの変更を監視する |
| `watchAll(callback, options?)` | namespace 内のすべての変更を監視する（値は `unknown`） |
| `migrate(plan)` | データを移行する（[データの移行](#データの移行)） |
| `exposeToPage(bridge, policy)` | MAIN world にキーを公開する（[MAIN world](main-world.md#storage-を公開する)） |
| `webextStorage.startBackground(options?)` | Background で Content Script からの操作を受け付ける |

### オプション

| オプション | 既定値 | 説明 |
| --- | --- | --- |
| `area` | `'local'` | `'local'` / `'sync'` / `'session'` |
| `validate` | なし | キーごとの validator（型ガード関数） |
| `bridge` | なし | MAIN world で使う場合のブリッジ（[MAIN world](main-world.md)） |

```ts
const session = webextStorage<{ 'cache.token': string }>({ area: 'session' })
```

## キーの規則

- ドットで区切った空でない文字列です（例: `settings.theme`）。空の区間・先頭や末尾のドットは使えません。
- `__webext_utils` で始まる区間、`__proto__` / `constructor` / `prototype` の区間はライブラリが予約しています。
- **`toString` や `valueOf` などの `Object.prototype` のプロパティ名は、トップレベルのキーとしては使えません。**
  Firefox の `storage.session` がこれらのキーを正しく扱えないため、どのブラウザ・領域でも同じく拒否します。
  `app.toString` のように namespace の中では使えます。
- `settings` の namespace は `settingsExtra` に一致しません（ドット境界で区切ります）。

## 値の検証

型はコンパイル時だけのものです。古いデータや他のコードが書いた値を確実に扱うには、`validate` に型ガード関数を指定します。キーは namespace を含む完全なキーです。

```ts
const storage = webextStorage<Schema>({
  validate: {
    'settings.theme': (value): value is 'light' | 'dark' =>
      value === 'light' || value === 'dark',
  },
})
```

- `get` / `set` で `false` を返すと `VALIDATION_ERROR` になります（validator が例外を投げた場合も同じで、`cause` に元の例外）。
- 変更通知では、検証に失敗した値は配信しません。
- 移行ステップ内では適用しません（古い形式のデータを扱うため）。

保存できるのは JSON 互換の値だけです。`undefined` を含む値や `Date` などは `SERIALIZATION_ERROR` です。

## 変更の監視

```ts
const subscription = storage.watch(
  'settings.theme',
  ({ oldValue, newValue }) => console.log(oldValue, '→', newValue),
  { onError: (error) => console.error(error.code) }
)
await subscription.ready // 登録の完了を待つ（失敗時は reject）
subscription() // 解除
```

- 登録時点の値では呼ばれません。現在の値は `get` で読んでください。
- 同じ値の書き込み（変化なし）では通知しません。
- 戻り値は関数として呼ぶと解除でき、`ready` で登録完了を待てます。
- `onError` は登録・再登録の失敗を通知します。失敗した購読は停止するので、原因を解消してから再度 `watch` してください。

複数のキーをまとめて監視すると、`key` で値の型を絞り込めます。

```ts
settings.watchAll(['theme', 'language'], (change) => {
  if (change.key === 'theme') change.newValue // 'light' | 'dark' | undefined
  else change.newValue // string | undefined
})
```

キーを省略した `watchAll(callback)` は namespace 内のすべての変更を受け取ります。スキーマ外のキーも届くため、値は `unknown` です。

## Content Script から使う

Content Script はストレージを Background 経由で操作します。Background で `startBackground()` を登録してください。

```ts
// background.ts
webextMessaging.startBackground()
webextStorage.startBackground({
  contentScriptAccess: { local: true, sync: true, session: false }, // 既定値
})
```

`session` 領域は既定で Content Script に公開しません。公開する場合は `session: true` を指定してください。
Content Script 側のコードは拡張機能のページと同じです。

## データの移行

`migrate(plan)` は namespace ごとにバージョンを管理し、未適用のステップだけを順に実行します。Background か拡張機能のページで実行してください（Content Script・MAIN world では使えません）。

```ts
const settings = webextStorage<Schema>().namespace('settings')

await settings.migrate({
  version: 2,
  steps: {
    1: (draft) => {
      if (draft.get('theme') === undefined) draft.set('theme', 'light')
    },
    2: (draft) => {
      const old = draft.get('darkMode') // unknown
      if (old === true) draft.set('theme', 'dark')
      draft.remove('darkMode')
    },
  },
})
// => { fromVersion: 0, toVersion: 2, applied: [1, 2] }
```

- `steps[n]` はバージョン `n - 1` から `n` への変更です。新規インストールではバージョン 0 から実行します。
- 各ステップは下書き（`draft`）を変更します。ステップがすべて成功してから、まとめて保存します。
- 保存済みのバージョンが `plan.version` より新しい場合は `SCHEMA_TOO_NEW`、ステップが例外を投げた場合は `MIGRATION_FAILED`（`details.step` にステップ番号）で、どちらもデータを変更しません。
- ステップの中で同じ領域の `get` / `set` などを呼ばないでください（`MIGRATION_FAILED`）。
- 親子関係にある namespace（`settings` と `settings.editor` など）を別々に移行することはできません。

### 中断からの復旧

移行は Web Locks で排他し、書き込み前に変更内容をジャーナルとして保存します。書き込み中に中断された場合は、次の操作時にジャーナルから復旧します。
ライブラリの外で同じデータが変更され、ジャーナルと矛盾する場合は `MIGRATION_CONFLICT` で停止し、データを上書きしません。

### sync 領域

`sync` は端末をまたいで原子的に更新できないため、`allowNonAtomicSync: true` の指定が必要です。ジャーナルは端末の `local` に保存します。

```ts
await webextStorage<Schema>({ area: 'sync' }).namespace('settings').migrate({
  version: 1,
  allowNonAtomicSync: true,
  steps: { 1: (draft) => draft.set('theme', 'light') },
})
```

## 保証しないこと

- ライブラリを使わずに `chrome.storage` へ直接書き込むコードとの排他
- 端末間の同期の順序と原子性
- 切断中に起きたすべての変更の履歴（MAIN world の監視は復帰時に最新値との差分を通知します）

## エラー

| コード | 原因 |
| --- | --- |
| `INVALID_ARGUMENT` | 不正・予約されたキー、不正なオプション |
| `SERIALIZATION_ERROR` | JSON 互換ではない値 |
| `VALIDATION_ERROR` | validator が値を拒否した |
| `QUOTA_EXCEEDED` | 容量の上限を超えた |
| `PERMISSION_DENIED` | `storage` 権限がない |
| `ACCESS_DENIED` | Content Script に公開していない領域 |
| `ROUTER_UNAVAILABLE` | Content Script から使ったが Background の登録がない |
| `UNSUPPORTED_OPERATION` | Web Locks がない環境 |
| `MIGRATION_FAILED` / `SCHEMA_TOO_NEW` / `MIGRATION_CONFLICT` | 移行の失敗 |
