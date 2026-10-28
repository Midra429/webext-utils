# 検証手順と結果

## 2026-10-28のリリース前確認

この節は今回のコード・依存・設定・ドキュメント整理後の結果です。実行環境はmacOS 27.2 (26B123) / arm64、Bun 1.4.4、Node 26.12.1、TypeScript 7.0.2、tsdown 0.23.3、Biome 2.6.3。過去の試験結果と今回未実行の条件は下で区別しています。

| 検証 | 結果 |
| --- | --- |
| frozen install、TypeScript、型テスト | 合格 |
| Biome lint / format | 89ファイル、警告・エラーなし。設定JSONも対象 |
| ユニットテスト | **217 passed / 0 failed、1,178 assertions** |
| ビルド・梱包consumer・利用例 | 合格。全6 ESM入口、Bundler / NodeNext、SSR、副作用、Tree Shaking |
| 実際のnpm install | ローカルtarballを別プロジェクトへoffline installし、rootと5サブパスをimport成功 |
| 資源検証 | 100並行要求後pending=0、idle追加接続=0、解除後Port/listener/session記録/pending=0 |
| Chrome for Testing **156.0.8078.73** | 基本+追加回帰 **28/28**、統合3/3、review2/2、popout/実SW停止13/13、sidePanel12/12 |
| Firefox **156.0.1** / geckodriver **0.37.1** | 基本+追加回帰 **27/28**、統合3/3、review2/2、popout12/12、sidePanel12/12 |

**Firefoxの追加回帰1件が失敗しているため、全検証合格・無条件のリリース可とは判断しません。** 初期対象の最低版Chrome142 / Firefox145とFirefox158は今回再実行せず、下記の過去結果を保持しています。

Firefox156.0.1の `storage.session` で、名前空間なしの `toString` キーをsetすると、nativeの `getKeys()` には存在しても `get()` / `get(null)` には値が返りません。native APIだけのset/getと既定値付きgetでも再現しました。local/sync、Chromeの全area、Firefox sessionの `fixture.intrinsic.toString` は成功します。既存データとの互換性を損なう保存キーの変換は導入していません。該当キーにはドット付きnamespaceを使用してください。恒久fixture `storage:prototype-keys` はこの失敗をスキップせず報告します。

ストレージ自身の継承プロパティ誤読はCRUD、移行draft/version、MAINの検証・復帰snapshotで修正済みです。追加単体3件で再現時の失敗から合格への変化を確認しています。

今回の生reportと削除一覧はソースの `docs/reports/2026-10-28-release.json` に保存しています。tsdownはTypeScript7のAPIにexperimental警告を出しますが、生成JS/d.tsとconsumer検証は成功しています。

## 再現コマンド

ソースチェックアウトで実行します。BunとNode/npm、実機検証用ブラウザを用意してください。

```sh
bun install --frozen-lockfile
bun run test:package
bun run typecheck
bun run test:types
bun run check
bun run test
bun run build:example
bun run test:runtime
```

`test:package` はclean buildとoffline packを行い、一時ディレクトリに展開したパッケージだけを独立consumerから利用します。Bundler / NodeNextの生成型、全サブパスのNode ESM import、同梱例、DOM/Chrome/Firefox/Bun型なしのconsumer、SSR、import副作用、root Tree Shakingと生成bundle実行、公開ファイルと文書リンクを検証します。registryに書き込む操作はありません。`npm pack` 自体も `prepack` で再ビルドします。

利用例とbrowser統合fixtureはビルド済みパッケージのexportsを参照するため、クリーンなチェックアウトでは `typecheck` より先に `test:package`（または `build`）を実行してください。リリースworkflowもこの順序で実行します。

`test:runtime` はnative fake上で100並行要求後のpending、idle時の追加接続、全解除後のPort / listener / session記録を確認します。実ブラウザの性能測定とは区別してください。

```sh
# --load-extensionが使用できるChrome for Testingを指定
export CHROME_BINARY='/path/to/Google Chrome for Testing'
bun run test:browser --chrome
bun run test:integration --chrome
bun run test:browser --chrome --review
bun run test:popout
bun run test:side-panel

# Firefoxとgeckodriverを指定
export FIREFOX_BINARY='/path/to/Firefox.app/Contents/MacOS/firefox'
export GECKODRIVER_BINARY='/path/to/geckodriver'
bun run test:browser
bun run test:integration
bun run test:browser --review
bun run test:popout --firefox
bun run test:side-panel --firefox
```

専用の一時profileとfixtureを使用し、終了時に削除します。macOSではFirefoxをLaunchServices経由で起動します。通常のユーザープロファイルを指定しないでください。sidePanelのFirefox自動DOM操作がブラウザに拒否される場合は `--manual` で通常のUIクリックを行う別試験が必要です。

`BROWSER_REPORT` / `POPOUT_REPORT` / `SIDE_PANEL_REPORT` / `PACKAGE_REPORT` / `RUNTIME_REPORT` に出力パスを指定すると結果を保存できます。ブラウザrunnerのtimeoutや起動失敗は合格として扱いません。

| 試験 | 主な対象 |
| --- | --- |
| 基本browser | context、双方向messaging、MAIN policy/cleanup、native storage、RPC/MAIN監視、journal復旧 |
| integration | 5モジュール連携、別viewからの変更監視、cleanup |
| review | tab移動後のwindowIdルーティング、大容量の移行・削除・journal復旧 |
| popout | 同じHTML、reuse、関連tab移動/消失、reload、復旧、Chrome実SW停止 |
| side-panel | scope、ページ設定、状態、gesture、nativeイベント、非対応操作 |

## 保管した過去の結果（今回の実行結果ではありません）

2026-10-21の最終レビューでは214単体 / 1,155 assertions、型・Lint・梱包・資源検証が合格しています。macOS 27.0.1 / arm64、Bun 1.4.3、TypeScript 7.0.2。

| ブラウザ | 過去に記録された結果 |
| --- | --- |
| Chrome for Testing 142.0.7444.175 / 156.0.8078.47 | 各基本27、review 2、統合3、popout/実SW停止13 |
| Firefox 145.0 / 158.0.1 | 各基本27、review 2、統合3、popout12 |
| sidePanel個別試験 | Chrome142/145/156、Firefox145/156/158の12項目。Firefox158は通常UIクリックで検証 |

生reportはソースの `docs/reports/2026-10-21-review.json` と `docs/reports/2026-10-21-side-panel.json` に保持しています。旧段階D/E/G/Hの日誌・重複reportはこの結果と恒久的な回帰テストに統合しました。reportは開発用の証跡で、npmパッケージには同梱しません。

## 未検証・保証しない条件

- 全64通信経路、native popup / sidebar / Optionsの全組合せ、全中間ブラウザ版、Windows/Linux。
- Firefoxイベントページの実unload後の復旧、Content Scriptの実navigation / BFCache、1,024回navigationによる購読cleanupの長時間試験。
- popout pending作成途中の実強制停止。保存状態の注入と新規manager復旧は単体・fixtureで検証しています。
- 通常/private間のstorage・Web Locks共有、実端末間sync。
- Firefox localの動的ディスクquota、unlimitedStorage時の物理容量、native書込頻度制限、非協調writerとの全競合。

MAINの認証、完全な原子性、切断中の全変更履歴、中断操作のexactly-onceは設計上保証しません。対応する制約は[互換性](compatibility.md)、[MAIN](main-world.md)、[移行](migrations.md)、[popout](popout.md)に記載しています。
