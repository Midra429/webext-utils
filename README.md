# @midra/webext-utils

Chrome と Firefox の Manifest V3 拡張機能を、**同じコードで同じように動かす**ための TypeScript ユーティリティ集です。

- **ブラウザ差をなくす**: Chrome の `sidePanel` と Firefox の `sidebarAction` のように API が異なる機能も、同じ関数・同じ引数・同じ結果で扱えます。
- **型安全**: メッセージ名やストレージのキーから、送受信データ・保存値の型を推論します。
- **依存なし**: 実行時の依存パッケージはありません。ESM のみ、Tree Shaking 対応です。

対象は desktop の Chrome 142 以降・Firefox 145 以降です。

## インストール

```sh
npm install @midra/webext-utils
```

拡張機能のビルドツール（Vite・esbuild・Bun など）でバンドルして使います。

## 機能

| import | 機能 | ガイド |
| --- | --- | --- |
| `@midra/webext-utils/messaging` | Background・Content Script・UI 間の型付きメッセージ | [messaging](docs/messaging.md) |
| `@midra/webext-utils/storage` | 型付きストレージ、変更の監視、データの移行 | [storage](docs/storage.md) |
| `@midra/webext-utils/side-panel` | サイドパネルの開閉・ページ設定・開閉通知 | [side-panel](docs/side-panel.md) |
| `@midra/webext-utils/popout` | ポップアップやサイドパネルを独立ウィンドウで開く | [popout](docs/popout.md) |
| `@midra/webext-utils/context` | 実行場所（Background・ポップアップなど）の判定 | [context](docs/context.md) |

すべての機能は `@midra/webext-utils` からも import できます。

## 使い方の例

```ts
// background.ts
import {
  webextMessaging,
  webextSidePanel,
  webextStorage,
} from '@midra/webext-utils'

// 最初の await より前に登録する（Background の起動ごとに必要）
webextMessaging.startBackground()
webextStorage.startBackground()
webextSidePanel.startBackground({ openOnActionClick: true })

const messaging = webextMessaging<{
  'app:version': { data: void; response: string }
}>()
messaging.on('app:version', () => '1.0.0')
```

```ts
// popup.ts / panel.ts / content-script.ts
import { webextMessaging, webextStorage } from '@midra/webext-utils'

const messaging = webextMessaging<{
  'app:version': { data: void; response: string }
}>()
const version = await messaging.send('app:version') // string

const settings = webextStorage<{
  'settings.theme': 'light' | 'dark'
}>().namespace('settings')

await settings.set('theme', 'dark')
const theme = await settings.get('theme') // 'light' | 'dark' | undefined
settings.watch('theme', ({ newValue }) => console.log(newValue))
```

```ts
// ボタンのクリックでサイドパネルを開閉する（Chrome でも Firefox でも同じ）
import { webextSidePanel } from '@midra/webext-utils/side-panel'

button.addEventListener('click', () => {
  webextSidePanel.toggle().catch(console.error)
})
```

Manifest の書き方やエントリーポイントごとの初期化は [はじめに](docs/getting-started.md) を参照してください。

## ドキュメント

- [はじめに](docs/getting-started.md): Manifest、Background の初期化、各ページでの使い方
- 機能ガイド: [messaging](docs/messaging.md) / [MAIN world](docs/main-world.md) / [storage](docs/storage.md) / [side-panel](docs/side-panel.md) / [popout](docs/popout.md) / [context](docs/context.md)
- [エラー](docs/errors.md): `WebextError` とエラーコードの一覧
- [ブラウザ差の扱い](docs/browser-differences.md): ライブラリが吸収する差と、その方法
- [利用例](examples/README.md): Chrome・Firefox で読み込める拡張機能の例
- [開発者向け](https://github.com/Midra429/webext-utils/blob/main/docs/development.md): ディレクトリ構成、テスト、リリース手順

すべての公開 API には JSDoc を付けています。エディターの補完・ホバーでも使い方を確認できます。

## ライセンス

[MIT](LICENSE)
