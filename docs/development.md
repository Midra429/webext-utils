# 開発者向けガイド

このライブラリを修正・リリースする人のためのガイドです（npm パッケージには含めません）。

## 方針

- **ブラウザ差をなくす**: 公開 API は Chrome と Firefox で同じ引数・同じ結果にします。揃えられない機能は提供しません（[ブラウザ差の扱い](browser-differences.md)）。
- **実行時の依存なし**: `dependencies` は空にします。開発用の依存は TypeScript・tsdown・Biome・Bun の型だけです。
- **import に副作用なし**: import やクライアントの作成だけでは、ブラウザ API・リスナー・接続に触れません（`sideEffects: false`）。
- **失敗を隠さない**: 失敗は `WebextError` で明示し、成功や「受信側なし」に読み替えません。
- **公開 API には JSDoc**: 公開する関数・型・オプションには、説明と例を JSDoc で書きます。

## ディレクトリ構成

```text
src/
  index.ts              ルート: 各モジュールの再 export のみ
  internal/             公開しない共通処理
    browser.ts          browser / chrome API をメソッド単位で取得
    errors.ts           WebextError、ErrorCode、ブラウザのエラーの分類
    json.ts             JSON 互換値の検査
    popout-record.ts    popout の保存形式（popout が書き、context が読む）
    types.ts            Unsubscribe、Subscription
    url.ts              拡張機能の URL の判定
  context/              実行場所の判定
  messaging/
    index.ts            webextMessaging
    hub.ts              JavaScript 環境ごとの送受信の中心（MessageHub）
    router.ts           Background のルーター
    protocol.ts         通信の形式と検査
    environment.ts      ブラウザ API の境界（テストで差し替える）
    port.ts             runtime.Port の補助
    page/               MAIN world とのブリッジ（ISOLATED 側 bridge.ts / MAIN 側 client.ts）
  storage/
    index.ts            webextStorage
    client.ts           公開クライアント
    runtime.ts          直接操作と Content Script 用の RPC
    engine.ts           Web Locks、移行、ジャーナル
    page-bridge.ts      MAIN world への公開
    subscription.ts     監視の登録状態
    utils.ts            キーの検査など
  side-panel/           サイドパネル
  popout/
    index.ts            webextPopout
    manager.ts          Background での管理と storage.session への記録
    utils.ts            オプションの検査など
tests/
  *.test.ts             単体テスト（ブラウザ API の偽物を使う）
  helpers/              ブラウザ API の偽物
  types/                型のテスト（tsc で検査）
  browser/              実ブラウザで読み込む拡張機能の fixture
scripts/                実ブラウザ試験、パッケージ検証、例のビルド
examples/               利用例（npm パッケージに含める）
```

依存の向きは次のとおりです。循環させないでください。

```text
internal ← context ← messaging ← storage
                   ← side-panel ← popout（messaging・context も使用）
```

## コマンド

```sh
bun install --frozen-lockfile
bun run build          # dist/ を生成
bun run typecheck      # 例と fixture はビルド済みの dist を参照するため、先に build する
bun run test:types     # 型のテスト
bun run test           # 単体テスト
bun run check          # Biome（lint / format）
bun run test:package   # npm pack した成果物を別プロジェクトから検証
bun run build:example  # examples/dist に Chrome・Firefox 用の拡張機能を出力
bun run test:runtime   # 偽のブラウザ API 上で資源の解放を計測
```

`test:package` は、梱包したパッケージを一時ディレクトリに展開し、型（Bundler / NodeNext）、全サブパスの import、同梱の例、SSR、import の副作用、Tree Shaking、ドキュメント内のリンクを検査します。registry への書き込みはしません。

## 実ブラウザでの試験

Chrome for Testing、Firefox と geckodriver が必要です。専用の一時プロファイルを使い、終了時に削除します。

```sh
export CHROME_BINARY='/path/to/Google Chrome for Testing'
bun run test:browser --chrome
bun run test:integration --chrome
bun run test:browser --chrome --review
bun run test:popout
bun run test:side-panel

export FIREFOX_BINARY='/path/to/firefox'
export GECKODRIVER_BINARY='/path/to/geckodriver'
bun run test:browser
bun run test:integration
bun run test:browser --review
bun run test:popout --firefox
bun run test:side-panel --firefox
```

| 試験 | 内容 |
| --- | --- |
| `test:browser` | context、messaging、MAIN world、storage、移行の復旧 |
| `test:integration` | 5機能の連携、別ページからの変更の監視、後片付け |
| `test:browser --review` | タブ移動後の宛先、大容量の移行 |
| `test:popout` | 同じ HTML の再利用、関連タブ、再読み込み、復旧 |
| `test:side-panel` | 開閉・切り替え・状態・ページ設定・開閉通知を**両ブラウザで同じ手順**で検査 |

`test:side-panel` は、クリックごとに1手順を実行します。Firefox で自動操作が拒否される場合は `--manual` を付け、表示されたボタンを手でクリックしてください。
結果を保存する場合は `BROWSER_REPORT` / `POPOUT_REPORT` / `SIDE_PANEL_REPORT` / `PACKAGE_REPORT` / `RUNTIME_REPORT` に出力先を指定します。

Linux で root として Chromium を動かす場合は `CHROME_FLAGS='--no-sandbox'` を指定してください（追加の起動引数として渡します）。

## 検証状況

2026-11-03 のリファクタリング時点の結果です。

| 検証 | 結果 |
| --- | --- |
| `check` / `typecheck` / `test:types` | 合格 |
| `test`（単体テスト） | 合格 |
| `test:package` / `build:example` / `test:runtime` | 合格 |
| Chrome for Testing 153.0.8010.12（Linux, headless） | `test:browser` 28/28、`test:integration` 3/3、`test:browser --review` 2/2、`test:popout` 13/13、`test:side-panel` 10/10 |
| Firefox | **未実施**。リリース前に `test:browser` / `test:integration` / `test:popout` / `test:side-panel` を Firefox で実行してください |

## 未検証・保証しない範囲

- Firefox での実機試験（上表）。特に、サイドパネルの開閉通知（パネルと Background の間の `runtime.Port`）と、イベントページが停止したときの再接続。
- Background の `action.onClicked`（`openOnActionClick`）からの開閉。単体テストでは、ネイティブ呼び出しがクリックの処理内で同期的に始まることを検証しています。
- Windows / macOS、全中間バージョン、プライベートウィンドウでの動作。
- Content Script の実際の BFCache、作成途中の popout の強制停止。
- 端末間の sync、ライブラリを使わない書き込みとの競合、Firefox の `local` の動的な容量。

## リリース

npm への公開は GitHub Actions の `Publish to npm` workflow で行います。lint・型検査・単体テスト・ビルド・パッケージ検証がすべて成功した場合だけ公開します。

### 初回設定

認証には [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)（OIDC）を使います。npm のパッケージ設定で、GitHub Actions を Trusted Publisher として登録してください。

| 設定 | 値 |
| --- | --- |
| Organization or user | `Midra429` |
| Repository | `webext-utils` |
| Workflow filename | `publish.yml` |
| Environment name | 空欄 |

`NPM_TOKEN` は不要です。パッケージがまだ存在せず設定画面を開けない場合は、所有者のローカル環境で上記の検査を実行してから `npm publish --access public` で初回公開し、その後 Trusted Publisher を登録します。

### 手順

1. GitHub の **Actions → Publish to npm → Run workflow** を開き、デフォルトブランチを選びます。
2. `bump`（`patch` / `minor` / `major`）を選んで実行します。バージョン更新・検査・commit とタグの push・npm 公開・GitHub Release の作成まで自動で行います。

検査が失敗した場合は commit もタグも push しません。タグの push 後に npm 公開だけが失敗した場合は、原因を解消してから、そのタグで GitHub Release を手動で公開すると再試行できます。

バージョンを手で更新する場合は、`package.json` の `version` を更新して push し、`v` + バージョン（例: `v0.1.0`）のタグで GitHub Release を公開します。タグの push だけでは公開されません。
