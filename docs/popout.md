# popout

`webextPopout` は、ポップアップやサイドパネルと同じ HTML を、独立したウィンドウ（popout）で開きます。

```ts
import { webextPopout } from '@midra/webext-utils/popout'
```

## 準備

Background で messaging と popout を登録します。Manifest に `storage` 権限が必要です。

```ts
// background.ts
webextMessaging.startBackground()
webextPopout.startBackground()
```

## popout を開く

```ts
const popout = await webextPopout.open({
  source: 'side-panel', // 'popup' または 'side-panel'
  associatedTabId: 42, // 任意: 操作対象のタブ
  width: 480,
  height: 720,
  reuseKey: 'inspector-42', // 任意: 同じキーなら既存のウィンドウを再利用
})
console.log(popout.windowId)
```

拡張機能のページと Background から呼び出せます（Content Script からは使えません）。

### オプション

| オプション | 既定値 | 説明 |
| --- | --- | --- |
| `source` | 必須 | 元にする UI。`'popup'` または `'side-panel'` |
| `page` | 元の UI のページ | 開くページ（相対パスまたは拡張機能の URL） |
| `associatedTabId` | なし | 関連付けるタブ。ハンドルからタブを操作できる |
| `width` / `height` | `480` / `720` | ウィンドウの大きさ（px） |
| `left` / `top` | ブラウザが決める | ウィンドウの位置（px） |
| `focused` | `true` | 開いたウィンドウにフォーカスするか |
| `reuseKey` | なし | 再利用キー |
| `sourceTarget` | なし | `source: 'popup'` のみ。ページ設定を読むタブ `{ tabId }` またはウィンドウ `{ windowId }` |
| `closeOriginal` | `false` | `source: 'popup'` のみ。開いた後に呼び出し元のポップアップを閉じる |

### 開くページの決まり方

1. `page` を指定した場合はそのページ
2. `source: 'popup'`: `action.getPopup()` の設定（`sourceTarget` を指定した場合はそのタブの設定。`windowId` はそのウィンドウのアクティブなタブとして扱います）
3. `source: 'side-panel'`: `webextSidePanel.getPage()` の設定

ページのクエリとハッシュは保持します。拡張機能以外の URL は `INVALID_ARGUMENT` です。

### 再利用

`reuseKey` が同じで、`source`・ページ・関連タブも同じ popout が開いていれば、新しく開かずにそのウィンドウへフォーカスします。同じキーでこれらが異なる場合は `INVALID_ARGUMENT` です。

### 呼び出し元を閉じる

`closeOriginal: true` は、呼び出し元がポップアップの場合に、popout を開いた後でポップアップを閉じます。結果はハンドルの `originalUiClose.status` で確認できます。

| `status` | 意味 |
| --- | --- |
| `not-requested` | 要求していない |
| `closed` | ポップアップを閉じた |
| `unsupported` | 呼び出し元がポップアップではない |
| `failed` | 閉じられなかった（`error` を参照）。popout は開いています |

サイドパネルは、popout を開いた後には閉じられません（ブラウザがユーザー操作を要求するため）。そのため `source: 'side-panel'` では指定できません。閉じる場合は、ユーザー操作の処理内で `webextSidePanel.close()` を呼び出してください。

## ハンドル

| プロパティ・メソッド | 説明 |
| --- | --- |
| `windowId` / `source` / `page` | ウィンドウ ID、元の UI、開いたページの絶対 URL |
| `associatedTabId` / `sourceTarget` / `reuseKey` | 作成時に指定した値 |
| `bounds` | ブラウザが実際に適用した位置と大きさ |
| `options` | 作成時のオプション（解決後の値） |
| `originalUiClose` | `closeOriginal` の結果 |
| `close()` | ウィンドウを閉じる |
| `getTab()` | 関連タブの最新情報（関連タブがなければ `CONTEXT_UNAVAILABLE`、閉じられていれば `TAB_NOT_FOUND`） |
| `tabExists()` | 関連タブが存在するか |
| `activateTab()` | 関連タブをアクティブにし、そのウィンドウにフォーカスする |
| `messageTarget(options?)` | 関連タブの Content Script を messaging の宛先として返す |

```ts
const title = await messaging.send('page:title', undefined, {
  target: popout.messageTarget(), // { context: 'content-script', tabId: 42, ... }
})
```

関連付けは固定です。アクティブなタブには追従しません。

## popout として開かれたページ

同じ HTML をポップアップ・サイドパネル・popout で使う場合、`getCurrent()` で popout かどうかを判別できます。

```ts
const current = await webextPopout.getCurrent()
if (current) {
  document.body.classList.add('popout')
  if (await current.tabExists()) await current.activateTab()
}
```

受信ハンドラー（`messaging.on`）を登録する場合は、`getCurrent()` または `webextContext.resolve()` の後にしてください。popout の判定が終わるまで、ページの実行場所は `unknown` です。

## その他の API

| API | 説明 |
| --- | --- |
| `webextPopout.get(windowId)` | ウィンドウ ID からハンドルを取得する（popout でなければ `undefined`） |
| `webextPopout.close(windowId)` | popout を閉じる（このライブラリで開いた popout 以外には何もしない） |

## 仕組みと制約

- popout の情報は Background が `storage.session` に保存し、ページの再読み込みや Background の再起動後も復元します。ブラウザの再起動をまたいでは復元しません。
- popout のウィンドウやタブを閉じたり、別の URL に移動したりすると、管理を終了します。関連タブが閉じられても popout は管理を続けます。
- 元の UI のメモリ上の状態はコピーされません（同じ HTML を新しく読み込みます）。状態は storage や messaging で共有してください。
