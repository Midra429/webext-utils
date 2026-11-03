# context

`webextContext` は、現在のコードがどこで実行されているか（Background・Content Script・ポップアップなど）を判定します。

```ts
import { webextContext } from '@midra/webext-utils/context'

const context = await webextContext.resolve()
switch (context.kind) {
  case 'background':
    break
  case 'content-script':
    console.log(context.world) // 'ISOLATED' | 'MAIN'
    break
  case 'popout':
    console.log(context.origin, context.windowId) // 'popup' | 'side-panel'
    break
}
```

## API

| API | 戻り値 | 説明 |
| --- | --- | --- |
| `get()` | `ContextInfo` | 同期的に判定する |
| `resolve()` | `Promise<ContextInfo>` | ブラウザ API に問い合わせて判定する |
| `register(role)` | `Unsubscribe` | 自動判定できない実行場所を宣言する |

## `ContextInfo`

| `kind` | 実行場所 | 追加の項目 |
| --- | --- | --- |
| `background` | Background（Chrome の Service Worker / Firefox のイベントページ） | |
| `content-script` | Content Script | `world: 'ISOLATED' \| 'MAIN'` |
| `popup` | ツールバーアイコンのポップアップ | |
| `side-panel` | サイドパネル | |
| `popout` | `webextPopout` で開いたウィンドウ | `origin`, `windowId`, `associatedTabId?` |
| `options` | オプションページ（`register` で宣言） | |
| `extension-page` | タブで開いた拡張機能のページ | |
| `devtools` | 開発者ツールのページ | |
| `unknown` | 判定できない | |

共通の項目として、確認できた場合は `tabId` / `frameId` / `windowId` / `documentId` / `instanceId` を持ちます。`source` は判定の根拠（`native` / `registered` / `verified-record` / `unknown`）です。

## `get()` と `resolve()`

| 実行場所 | `get()` | `resolve()` |
| --- | --- | --- |
| Background・Content Script（ISOLATED）・ポップアップ・タブ・開発者ツール | 判定できる | 判定できる（ID なども取得） |
| サイドパネル・popout | `unknown` | 判定できる |
| オプションページ・MAIN world | `register` が必要 | `register` が必要 |

サイドパネルと popout はブラウザ API への問い合わせが必要なため、`get()` では判定しません（Chrome と Firefox で同じ結果にするため）。
`resolve()` の結果はキャッシュされ、以後の `get()` でも参照できます。

## `register()`

次の実行場所は、エントリーポイントの先頭で宣言してください。

```ts
// オプションページ（タブで開いたページと区別できないため）
webextContext.register({ kind: 'options' })

// MAIN world の Content Script（拡張機能 API がないため）
webextContext.register({ kind: 'content-script', world: 'MAIN' })
```

- `popout` と `unknown` は宣言できません。
- ブラウザから確認できる情報と矛盾する宣言は `INVALID_ARGUMENT` です。
- 宣言は自己申告です。権限の判断には使わないでください。

## エラー

| コード | 原因 |
| --- | --- |
| `CONTEXT_UNAVAILABLE` | 拡張機能の実行環境ではない（`resolve()`）、判定中にページが変わった |
| `INVALID_ARGUMENT` | 不正な宣言、ブラウザの情報と矛盾する宣言 |
| `NATIVE_ERROR` | ブラウザ API の失敗（`cause` に元のエラー） |
