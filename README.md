# @midra/webext-utils

Chrome・FirefoxのManifest V3拡張機能向けTypeScriptユーティリティです。型付き通信、ストレージ、サイドパネル、独立ウィンドウ、実行コンテキストの判定を共通APIで扱えます。フレームワーク・ランタイム依存なし、ESM専用、Tree Shaking対応です。

## インストール

```sh
npm install @midra/webext-utils
# または
bun add @midra/webext-utils
```

未公開のソースを試す場合は、リポジトリで `bun install --frozen-lockfile && bun run build`、`npm pack` を実行し、利用側で生成された `.tgz` をインストールします。`npm pack` は `prepack` で再ビルドします。公開操作は行いません。

拡張機能のビルドツールでbundleしてください。各サブパスとrootのnamed importを利用できます。公開型の利用にChrome・Firefox・Bunの型パッケージは不要です。

## モジュール

| インポート | 公開名 | 用途 |
| --- | --- | --- |
| `@midra/webext-utils/context` | `webextContext` | [実行場所とpopoutの判定](docs/context.md) |
| `@midra/webext-utils/messaging` | `webextMessaging` | [型付き要求・応答・通知、MAINブリッジ](docs/messaging.md) |
| `@midra/webext-utils/storage` | `webextStorage` | [local/sync/session、名前空間、監視・移行](docs/storage.md) |
| `@midra/webext-utils/sidePanel` | `webextSidePanel` | [Chrome sidePanel / Firefox sidebarAction](docs/side-panel.md) |
| `@midra/webext-utils/popout` | `webextPopout` | [同じUIを独立ウィンドウで開く、タブ関連付け](docs/popout.md) |

## 基本的な使い方

Backgroundの入口では、最初の `await` より前に使用するサービスとハンドラーを同期登録します。再起動ごとに同じ登録が必要です。

```ts
// background.ts
import { webextMessaging } from '@midra/webext-utils/messaging'
import { webextStorage } from '@midra/webext-utils/storage'

type Messages = {
  'app:version': { data: void; response: string }
}

webextMessaging.startBackground()
webextStorage.startBackground() // Content Script / MAINからstorageを使う場合
const messaging = webextMessaging<Messages>()
messaging.on('app:version', () => '1.0.0')
```

別の拡張機能ページやISOLATED Content Scriptで、同じメッセージ型を使用します。送信先の既定値はBackgroundです。

```ts
import { webextMessaging } from '@midra/webext-utils/messaging'
import { webextStorage } from '@midra/webext-utils/storage'

const messaging = webextMessaging<{
  'app:version': { data: void; response: string }
}>()
console.log(await messaging.send('app:version'))

const settings = webextStorage<{
  'settings.theme': 'light' | 'dark'
}>().namespace('settings')

const stop = settings.watch('theme', ({ newValue }) => console.log(newValue))
await stop.ready
await settings.set('theme', 'dark')
const theme = await settings.get('theme') // 'light' | 'dark' | undefined
stop() // 購読解除
messaging.dispose()
```

キーの型は実行時の値検証を代替しません。既存データや別writerを扱う場合は `validate` を設定してください。監視の再登録エラーには `onError`、型付きの複数キー監視には `watchAll(keys, callback)` を使用します。

```ts
import { webextContext, webextSidePanel, webextPopout } from '@midra/webext-utils'

const context = await webextContext.resolve()
console.log(context.kind)

// panel.htmlをManifestに設定し、ユーザー操作から直接呼び出す
document.querySelector('button')?.addEventListener('click', () => {
  void webextSidePanel.open().catch(console.error)
})

// Background側でwebextMessaging.startBackground()に続けて
// webextPopout.startBackground()を登録しておく
const popout = await webextPopout.open({
  source: 'popup', // action.default_popupと同じHTMLを使用
  reuseKey: 'inspector',
})
console.log(popout.windowId)
```

エラーは各モジュールがexportする `WebextError` / `isWebextError` と `code` で判別できます。非対応の操作・権限不足・timeoutを成功として扱いません。[API索引とエラー一覧](docs/api.md)を参照してください。

## 対応環境・権限・制約

対象はdesktop Chrome 142–156 / Firefox 145–158（初期対応範囲）です。実測した版・範囲と未検証条件は[検証結果](docs/testing.md)に記載しています。ChromeはMV3 Service Worker、Firefoxは非永続Backgroundページを使用します。

- `storage` 権限: storage、messagingの受信登録復元、popout管理に必要です。storageとpopoutの排他にはWeb Locksを使用します。
- サイドパネル: Chromeは `sidePanel` 権限と `side_panel`、Firefoxは `sidebar_action` を設定します。開く操作はユーザー操作から直接呼び出してください。
- Chromeのパネル状態は `unknown`。Chrome 142–144のtab限定close、Firefoxのwindow/tab指定open/closeは非対応です。
- タブのURL・titleを取得する場合は `tabs` または対象URLのhost権限が必要です。Content Scriptの注入対象も利用側で指定します。
- MAINは信頼できないページと同じ権限境界です。ISOLATEDで明示的な許可・validatorを設定した操作だけを公開します。channelは認証情報ではありません。
- Firefox156のsessionでは名前空間なしの `toString` キーをnative APIから読み戻せない制約があります。ドット付きnamespaceを使用してください。[回帰試験と制約](docs/testing.md)に詳細があります。
- 移行の完全な原子性、端末をまたぐ排他、中断要求のexactly-once、切断中の全変更履歴は保証しません。

完全なManifestは [Chrome](examples/manifest.chrome.json) / [Firefox](examples/manifest.firefox.json)、ブラウザ差の詳細は[互換性ガイド](docs/compatibility.md)にあります。

## 詳細ガイド

[API索引](docs/api.md) · [5モジュールの統合](docs/integration.md) · [MAIN world](docs/main-world.md) · [データ移行](docs/migrations.md) · [実行可能な利用例](examples/README.md) · [検証手順・既知の未検証範囲](docs/testing.md)

## npmへのリリース

`Publish to npm` workflowの手動実行、またはGitHub Releaseの公開からnpmへリリースできます。lint・型検査・単体テスト・ビルド・配布パッケージ検証の成功後に、npmの `latest` に公開します。

### 初回設定

認証には [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)（OIDC）を使用します。npmのパッケージ設定でGitHub ActionsをTrusted Publisherとして登録してください。

| 設定 | 値 |
| --- | --- |
| Organization or user | `Midra429` |
| Repository | `webext-utils` |
| Workflow filename | `publish.yml` |
| Environment name | 空欄 |
| Allowed actions | `npm publish` による直接公開を許可 |

このworkflowに `NPM_TOKEN` Secretは不要です。新規のTrusted Publisher設定は2日以内に初回公開を成功させる必要があります。パッケージがまだ存在せず設定画面を開けない場合は、先に所有者のローカル環境で `npm login`、`bun install --frozen-lockfile`、上記の検査・テスト、`npm publish --access public` を実行して初回公開し、その後Trusted Publisherを登録します。初回公開前に `package.json` の `version` を公開したい版へ更新してください。

### リリース手順

GitHubの **Actions → Publish to npm → Run workflow** を開き、デフォルトブランチを選択します。`bump` で更新種別を選んで実行すると、バージョン更新、検査、commit・タグのpush、npm公開、GitHub Release作成まで自動で行います。

| bump | `1.2.3` からの更新例 |
| --- | --- |
| `patch` | `1.2.4` |
| `minor` | `1.3.0` |
| `major` | `2.0.0` |

検査失敗時はcommit・タグをpushしません。リポジトリのルールで、GitHub Actionsによるデフォルトブランチへのpushが許可されている必要があります。

手動実行では同じworkflow内でnpm公開まで行うため、追加のPATは不要です。`GITHUB_TOKEN` によるRelease作成は[別のworkflow実行を起動しません](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)。タグのpush後にnpm公開が失敗した場合は、原因を解消し、そのタグでGitHub Releaseを手動公開すると、バージョンを増やさずに公開を再試行できます。npm公開後にGitHub Release作成だけが失敗した場合は、そのタグのReleaseを手動で作成し、再度のnpm公開は不要です。

バージョンを自分で更新する場合は、従来の手順も使用できます。

1. `package.json` の `version` を未公開の版（例: `0.1.0`）に更新し、変更をcommit・pushします。
2. そのcommitに対応するタグ（例: `v0.1.0`）でGitHub Releaseを作成し、公開します。タグのpushだけではnpmへ公開されません。
3. GitHub Actionsの `Publish to npm` が成功したことを確認します。

`version` は `major.minor.patch` 形式とし、タグ名は必ず `v` + `package.json` の `version` と一致させてください。公開済みの同一バージョンは再公開できないため、次回は新しいバージョンを使用してください。

ライセンス: [MIT](LICENSE)
