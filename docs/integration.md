# 5モジュールの組み合わせ

ビルド・型チェックできる例は [examples](../examples/README.md) にあります。通常UIとpopoutで同じHTMLを使い、設定の保存・監視、サイドパネルの表示、MAINへの公開操作を組み合わせています。

## Background

最初のawaitより前に、利用するサービスとhandlerを毎回登録してください。

```ts
import { webextMessaging, webextStorage, webextPopout } from '@midra/webext-utils'

const stopRouter = webextMessaging.startBackground()
const stopStorage = webextStorage.startBackground()
const stopPopout = webextPopout.startBackground()
// application handlerもここで同期登録する
```

停止する場合は依存する登録から `stopPopout()`、`stopStorage()`、最後に `stopRouter()` を呼びます。通常のSW終了時にこの解除を実行する必要はありません。SW再起動後にメモリ上の変数は引き継がれないため、データはstorage、popout管理情報と受信候補はsessionから復元します。中断した業務要求は自動再送しません。

移行中の同realm・同areaへの公開CRUD再入は拒否します。handler自体は同期登録し、handlerの本体で初期化Promiseをawaitする例を [background.ts](../examples/background.ts) に示しています。移行は毎回同じversionで実行でき、適用済みstepを繰り返し実行しません。

## 共通のUIページ

```ts
import { webextContext, webextMessaging, webextPopout } from '@midra/webext-utils'

const current = await webextPopout.getCurrent()
const context = await webextContext.resolve()
const messaging = webextMessaging<{
  'page:title': { data: void; response: string }
}>()
if (current?.associatedTabId !== undefined) {
  const title = await messaging.send('page:title', undefined, {
    target: current.messageTarget(),
  })
  console.log(title)
}
```

popoutの予約tokenはnative tab/window・session記録と照合するまでunknownです。受信用 `messaging.on` はこの照合後に登録します。自己申告でpopup/popoutを登録して照合を省略しないでください。通常のUIでは `getCurrent()` はundefinedです。

tabを関連付ける場合、利用側が取得した既知のIDを指定します。

```ts
const handle = await webextPopout.open({
  source: 'sidePanel',
  sourceTarget: { tabId: 42 },
  associatedTabId: 73,
  reuseKey: 'inspector-73',
})
```

`sourceTarget` はHTMLを取得する設定元、`associatedTabId` は操作対象であり独立です。関連付けは固定し、アクティブタブに自動追従しません。関連なしならtab操作を省略します。元UIを閉じる場合は `closeOriginal: true` と結果の `originalUiClose` を使用し、popout作成成功と元UI close成功を別々に確認します。

## MAINとstorage

[ISOLATED例](../examples/isolated.ts) はoriginを `https://example.com` に限定し、`settings:theme` の固定Background宛先と、storageのtheme read/watchだけを公開します。[MAIN例](../examples/main.ts) は同じchannelでその操作を呼びます。ページから書き込めるようにする場合は、明示的にwrite ACLとvalidatorを追加します。

`channel` は認証情報ではありません。同じページ上のコードも許可操作を呼び出せます。秘密、汎用native呼び出し、任意の宛先を公開しないでください。bridge自体の文書寿命・BFCache処理はライブラリが管理します。アプリケーション独自の購読は入口の寿命に合わせて解除し、復帰時に必要なら再購読します。

## 検証を再現する

```sh
bun run typecheck
bun run test:types
bun test tests
bun run check
bun run test:runtime
bun run test:package
bun run build:example
# Chrome for Testingを指定
CHROME_BINARY='/path/to/Chrome for Testing' bun run test:browser --chrome
CHROME_BINARY='/path/to/Chrome for Testing' bun run test:integration --chrome
# R1の実タブ移動、R2の合計1MiB超移行・更新・削除・大容量journal復旧
CHROME_BINARY='/path/to/Chrome for Testing' bun run test:browser --chrome --review
# Firefoxとgeckodriverを指定（macOSではLaunchServicesで専用profileを起動）
FIREFOX_BINARY='/path/to/Firefox.app/Contents/MacOS/firefox' GECKODRIVER_BINARY='/path/to/geckodriver' bun run test:browser
FIREFOX_BINARY='/path/to/firefox' GECKODRIVER_BINARY='/path/to/geckodriver' bun run test:integration
FIREFOX_BINARY='/path/to/firefox' GECKODRIVER_BINARY='/path/to/geckodriver' bun run test:browser --review
```

`BROWSER_REPORT=/path/to/report.json` を付けるとブラウザの版・OS・個別結果・不足項目を保存します。`test:popout`のreportには`POPOUT_REPORT=/path/to/report.json`を使います。`PACKAGE_REPORT` / `RUNTIME_REPORT` は配布・native fake上の資源計測を保存します。

`test:package` は [npm pack](https://docs.npmjs.com/cli/v11/commands/npm-pack/) をoffline・lifecycle無効で実行し、一時consumerに展開します。[TypeScriptのexports解決](https://www.typescriptlang.org/docs/handbook/modules/reference.html#packagejson-exports) をBundlerとNodeNextの両方で検証し、Chrome/Bun/DOMの型がないconsumer、同梱例、Node ESM、SSR、副作用、root Tree Shaking後の実行を確認します。公開・インストール・registryへの書き込みは行いません。

統合試験の3項目は、5モジュールの連携（2種のpopout・同一HTML・storage移行・関連tab通信）、別viewからの変更監視、cleanupを検査します。通常popup/sidebarの全64通信経路や実BFCacheまで検査したという意味ではありません。[検証結果と未検証項目](testing.md) を確認してください。
