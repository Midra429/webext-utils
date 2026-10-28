# 設計と保守計画

2026-10-28更新。5モジュールは実装済みです。初期の実装予定・段階別日誌・重複API案は現行の[仕様](spec.md)と各[APIガイド](api.md)へ集約しました。未検証条件は[検証結果](testing.md)で管理します。

## 責務と依存方向

```text
src/context     実行場所・native identity・popout記録の読取
src/messaging   realm / router / protocol / MAINブリッジ
src/storage     client / runtime・RPC / engine・journal / MAINのACL
src/sidePanel   native操作・scope・capability
src/popout      公開handle / Background manager・session記録
src/internal    native境界・共通エラー・JSON・URL・popout記録
```

- messaging → context。storage → messaging（Environment・RPC・ブリッジ）。popout → messaging / context / sidePanel。
- contextは `internal/popout-record` だけを読み、popoutや公開storageをimportしない。sidePanelはinternalにのみ依存する。
- internalは公開モジュールへ依存しない。rootは再exportのみ。内部モジュールを公開exportsへ追加しない。
- テストは内部native境界を差し替える。汎用DIやtransportプラグイン層は導入しない。

## 維持する設計判断

| 判断 | 理由・保守時の注意 |
| --- | --- |
| ネイティブPromise APIをメソッドごとに選択 | 部分polyfillと共存し、receiverを保持する。全APIを包む実行時polyfillは不要 |
| JSON契約 | ChromeとFirefoxで一致する範囲を扱う。Dateやundefinedを暗黙変換しない。公開入力とMAINの境界検査を維持 |
| Background routerとsession受信候補 | 複数受信先から最初の応答を選ぶ競合を防ぐ。登録は同期、復旧は必要時、業務要求は自動再送しない |
| MAINのJSON文字列CustomEvent | Firefoxのworld間オブジェクト制約を避ける。channelは公開情報、固定宛先・validator・ACL・サイズ/頻度制限が必須 |
| Web Locks + journal | storageにはCASもトランザクションもない。協調writer内でのみ排他し、非協調writerとの競合は読取照合で検出 |
| popoutのsession記録 | reload / SW再起動を越えて復元し、ブラウザ再起動を越えるIDは保存しない。pendingとreadyを区別 |
| sidePanelのunknown / unsupported | 可視状態の推測や設定変更による擬似closeを提供しない。gestureをBackground relayで保証しない |
| 小さな修正を回帰テストで固定 | 既存のAPI・型契約を守り、同じ責務の実際の重複だけを共通化する |

native機能差の根拠は[互換性](compatibility.md)に集約しています。ブラウザ範囲を広げる場合は公式仕様と実機結果の両方を更新してください。

## 回帰で守る不具合修正

2026-10-21のレビューで修正済みの項目を以下に残します。原因の詳細と期待動作は対応テストで保守します。生reportは `reports/2026-10-21-review.json`、sidePanelの個別実機結果は `reports/2026-10-21-side-panel.json` です。

| 項目 | 維持する動作 | 主な検証 |
| --- | --- | --- |
| タブ移動後の宛先 | windowId照合直前に現在の所属を再取得、古いsessionも更新。解除時は消滅済みtabを要求しない | messaging単体、browser review |
| 大容量移行 | 1MiBはJSON値/通信境界の制限。native領域全体やjournal全体に適用しない。各中間書込とmetadataのquotaを照合 | storage単体、browser review |
| 型付き全監視 | 明示キーで実行時filter。キー省略はstring/unknown | storage単体・bridge・型テスト |
| watch登録結果 | callable subscriptionのready / onError、失敗時cleanup、遅延受理後の解除 | storage-bridge / page-bridge |
| 失効購読 | tab閉鎖、navigation、Port切断、上限到達時にdocument/instanceを照合して掃除。生存購読は保持 | storage-bridge |
| popoutイベント負荷 | 管理tab/windowとURL/statusで絞り込み、連続要求を集約。開始・公開操作では全件検査 | popout単体・実機 |
| prototype名のキー（2026-10-28） | 存在しないtoString/valueOf等を継承プロパティから読まない。CRUD、移行draft、namespace versionで同じ契約 | storage単体 |

旧開発版からの注意: `watchAll(callback)` をschema由来の狭い型とした旧案は不正確でした。現行は `watchAll(keys, callback)` で型付き監視し、キー省略はunknownです。`StorageSubscription` は従来の解除関数として呼べます。今回の仕上げではこの現行公開APIを変更しません。

## 配布と開発環境

- `bun.lock` を固定して開発依存を再現する。必要なdevDependenciesはBun型、TypeScript、tsdown、Biomeのみ。ランタイム依存はない。
- `tsdown.config.ts` がrootと5サブパスのESM / d.tsを生成する。clean buildで古いchunkを除去する。
- `package.json.files` でdist・利用者向けガイド・利用例だけを同梱する。仕様/計画、過去report、tests、scripts、lockfileは公開しない。README / LICENSE / package.jsonはnpmの標準同梱。
- `prepack` がビルドする。`test:package` は先にビルドしたうえでoffline / ignore-scriptsのtarballを別consumerに展開し、作業ツリーのpaths aliasを使わず検証する。
- `sideEffects: false` はimport時のpoisoned globals検査とbundleの実行で維持する。生成宣言はBundler / NodeNextで検査する。
- `.gitignore` は依存・生成物・ローカル設定・OS/editorファイルに限定する。未知のファイルや利用者の変更を削除しない。

## リリース前の残作業

Firefox156のsessionでrootキー `toString` のnative getが欠落する回帰が未解消です。保存済みキーの変換や制約を隠すfallbackは導入しません。ドット付きnamespaceを使用する制約を公開契約に含めるか、ブラウザ側修正を確認するまで、全検証合格とは判断しないでください。fixtureと今回の結果は[検証結果](testing.md)に残しています。


[検証手順](testing.md)を再実行し、対応範囲の最低版と現行版、未検証の寿命条件・OSを確認してください。初期バージョンは `0.0.0` のままです。公開時のバージョンと対象ブラウザ範囲は公開担当者が決め、registry上の名前・公開権限も公開前に確認します。この作業では公開操作を行いません。
