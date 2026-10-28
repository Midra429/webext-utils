# 保守用仕様

2026-10-28更新。初期要件から、今後の互換性維持と回帰確認に必要な契約を集約しました。公開APIの詳細は[API索引](api.md)、実装上の判断は[設計・保守計画](plan.md)、検証済み範囲は[検証結果](testing.md)を参照してください。

## 共通契約

- TypeScript strict / exactOptionalPropertyTypes / noUncheckedIndexedAccess。既存の公開名・引数・戻り値・型推論を維持する。
- Chrome / Firefoxのdesktop MV3に対応し、ネイティブAPIをメソッド単位で機能検出する。初期対象はChrome 142–156 / Firefox 145–158。未試験の版を検証済みとしない。
- フレームワーク・ランタイム依存なし。ESM、rootと5サブパス、Tree Shaking、ブラウザambient型を要求しない宣言を提供する。
- import / factory生成でnative API、listener、Portに触れない。SSRでimportでき、ブラウザ操作の非対応は明示する。
- 非同期操作はPromise、購読は冪等な解除関数。エラーは `WebextError` の `code` / `operation` と必要に応じた `cause` / `details` で識別する。
- JSON互換値だけを通信・保存する。非有限数、循環、getter、疎配列、Date等を暗黙変換しない。容量・深さ・ノード数を制限する。
- 循環依存、常時heartbeat、無用なlistener、拡張機能権限の暗黙公開を避ける。失敗を成功や受信側不在へ広く変換しない。

## messaging

- メッセージ名ごとにdata / responseを推論する。グローバル `WebextMessages` と明示型を統合し、同名は明示型を優先する。
- `send` は要求・応答、`notify` / `notifyAll` はvoid応答の通知。async handler、並行要求、timeout、解除・disposeを扱う。
- 既定の宛先はBackground。context / tab / frame / window / document / instanceで絞り込み、単一宛先の複数一致は実行前に拒否する。`notifyAll` は明示宛先を必須とし、配送結果を返す。
- `ignoreMissing` は確認できた `NO_RECEIVER` のみを抑制する。権限、router不在、切断、timeout、handler例外は伝える。
- Backgroundは入口で同期登録する。sessionの受信候補と必要時のPort接続で再起動後に復旧し、実行途中の業務要求は再送しない。
- MAINはISOLATEDの明示ブリッジを使う。origin・方向・メッセージ名・固定宛先・入出力validator・資源上限を検査する。ページの自己申告senderは信頼しない。
- ナビゲーション・BFCache・disposeでは旧文書への応答を破棄し、待機処理と接続を解放する。実BFCacheの検証状況は別途記録する。

## storage

- `local` / `sync` / `session` の単体・一括CRUD、階層namespace、変更監視、バージョン付き移行を提供する。
- schemaからキーと値を推論し、未保存値はundefined。実行時はJSON・キー構文・予約キー・明示parserを検証する。型引数から実行時validatorは生成しない。
- namespaceはドット境界で分離する。`__webext_utils*`、空セグメント、`__proto__` / `constructor` / `prototype` を拒否する。`toString` 等のその他の有効キーは通常の保存キーとして扱う。Firefox sessionのnativeキー制約は[互換性](compatibility.md)に明記する。
- watchはold/newを通知し、no-op・内部メタデータを除外する。登録結果を `subscription.ready`、再登録失敗を `onError` で通知する。失敗した購読は停止する。
- `watchAll(keys, callback)` は実行時にもキーを限定する。キー省略の全監視はstring/unknownであり、schema由来の狭い型を保証しない。
- UI/Backgroundの操作はnative、ISOLATEDはBackground RPC、MAINはread/write/watch別ACLを経由する。Content Scriptのsessionアクセスは既定で無効。MAINから移行は許可しない。
- 移行はnamespaceごとにversionを管理し、Web Locksとjournalで協調writer間の排他・中断復旧を行う。適用済みstepを繰り返さず、保存済みの新しいversionや競合を拒否する。
- 移行draftは終了後に使えない。同realm・同areaの移行stepから公開CRUDへ再入しない。既知quotaを事前確認し、失敗時にversionだけ進めない。
- syncは `allowNonAtomicSync: true` が必須。外部native writer、別端末、物理ディスク容量、切断中の履歴、完全な原子性は保証外。

## sidePanel

- `sidePanel` / `sidebarAction` のopen / close、page設定・取得、状態、nativeイベント、capabilityを共通APIで提供する。
- scopeはtabIdまたはwindowIdの排他的指定。非対応scopeは明示エラーにする。
- Chromeの可視状態はunknown。イベント履歴や設定値を現在状態として扱わない。Chrome 145未満・版不明のtab限定closeは拒否する。
- Firefoxのopen / closeはactive windowのみ。ユーザー操作からnative呼び出しまで事前awaitを挟まない。native開閉イベントを擬似生成しない。
- pageは自拡張機能URLのみ。Manifest・権限・開く入口は利用側の責務。

## popout

- popup / sidePanelの既存HTMLをnative popup windowで開く。元UIの設定は変更しない。
- ページ自動取得、明示page、サイズ・位置・複数window・reuseKey、closeに対応する。
- `sourceTarget`（ページ設定の取得元）と `associatedTabId`（固定の操作対象）を区別する。関連tabの存在・情報・activate・messaging targetを提供する。
- native tab/window・URL・予約token・session記録を照合する。URLやwindow種別だけでライブラリのpopoutと断定しない。
- Background writer、Web Lock、pending/ready journalでreload・再起動から復旧する。閉鎖・移動・別URLを再検証し、無関係なtabイベントで全走査しない。
- `closeOriginal` の結果はpopout作成結果と区別する。元UI closeの非対応を成功としない。
- セッションを越えたID復元、作成途中のexactly-onceは保証しない。

## context

- Background、ISOLATED / MAIN、popup、side panel、popout、Options、拡張機能ページ、DevTools、unknownを区別する。
- `get()` は同期的な証拠とcache、`resolve()` はnative情報・popout記録を再確認する。曖昧ならunknownにする。
- MAINと通常ページ、共用HTMLのOptionsは入口で明示登録する。登録は権限・認証の根拠にしない。
- 文書変更・BFCacheでcacheを無効化し、古いresolve結果を採用しない。iframeが親のdocument IDを借用しない。

## リリース時の検証

型チェック、Lint/format、ビルド、単体・型・実ブラウザ統合、配布tarballの独立consumerでのimport / d.ts / SSR / Tree Shaking、資源解放を確認する。テストや機能を削除して合格させない。失敗・未実施・過去の成功を区別する。

公開APIの使用例、必要な権限、ブラウザ差、非対応・未検証条件を利用者向けガイドへ記載する。公開・push・release作成は別途の明示指示がある場合だけ行う。
