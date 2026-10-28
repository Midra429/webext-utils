# Storage移行

移行は拡張機能originのBackground / 拡張機能ページで実行します。Content ScriptとMAINからは実行できません。新規インストールもversion 0の空snapshotから同じstepを通します。

```ts
const settings = webextStorage<Schema>().namespace('settings')
await settings.migrate({
  version: 2,
  steps: {
    1: draft => {
      if (draft.get('theme') === undefined) draft.set('theme', 'light')
    },
    2: async draft => {
      const old = draft.get('notifications') // unknown
      draft.set('notifications', typeof old === 'boolean' ? old : true)
      draft.remove('oldPreference') // 旧キーも扱える
    },
  },
})
```

`steps[n]` はn−1→nです。必要なstepの欠番・非整数/負versionは `INVALID_ARGUMENT`。保存versionが目標より大きい場合は `SCHEMA_TOO_NEW` とし、変更しません。同versionではstepを実行しません。返り値の `applied` は今回実行したstep番号の配列です。

draftはnamespace内の隔離snapshotです。JSONの1MiB・深さ64・ノード数の制限は各値に適用し、namespace全体やjournal全体に1MiB制限を課しません。個別に保存できる値の合計が1MiBを超えても、journalと移行途中のデータを含めてnative容量内なら移行・復旧できます。通信境界のJSON制限は維持しています。getはunknownを返し、setはJSON値を受け付けます。読み出し値もコピーするので、取得objectの変更だけでは保存されません。終了後のdraft利用は拒否します。現在のstore parserを旧データに押し付けません。

移行関数内から公開storeのCRUDや別migrateを呼ぶことは禁止です。同realmの同areaではasync step実行中の公開操作を保守的に再入として拒否するため、同realmの無関係な処理も移行完了後に開始してください。別realmからのCRUD、およびネイティブsenderで確認した外部RPCは同じWeb Lockで待機します。step失敗は `MIGRATION_FAILED` とし、`details.step` と `cause` を持ちます。step失敗時点ではデータ/version/journalを変更しません。

## 確定と復旧

1. area単位の排他Web Lockを取得します。root CRUDとnamespace移行も同じロックです。Web Locksが利用できなければ `UNSUPPORTED_OPERATION`。storage内の偽ロックへfallbackしません。
2. 未完了journalを先に復旧し、namespaceの保存versionを取得します。親子やrootとの重複移行単位は拒否し、兄弟namespaceは独立してversion管理します。
3. snapshotを読み、必要なstepをメモリ上で順に実行します。async関数も使えますが、短く冪等にし、外部副作用を避けてください。
4. journal保存時・set前・remove後のversion確定時の容量を既知のnative quotaと照合します。native公開定数を優先し、sessionは既定10MiB、syncは合計・項目別・件数も検査します。Chrome localのunlimitedStorage許可を照会し、Firefoxの動的なlocal容量にChromeの固定上限を押し付けません。動的なディスク容量・書き込み頻度・外部writerの競合は事前に完全判定できず、nativeで失敗した場合はjournal復旧契約に従います。容量不足はQUOTA_EXCEEDEDで、データ/version/journalを変更しません。続いて変更前/後の値・削除キー・元/目標version・namespace・IDを持つjournalを先に保存します。容量不足ならデータの変更を始めません。
5. set/removeを適用し、読み戻して照合します。versionも直前に再取得し、観測済みの外部version変更を検出します。
6. versionを確定し、最後にjournalを削除します。

journal保存後の復旧には移行関数は不要です。次のlibrary CRUD/migrateが変更後値を再適用し、照合・version確定・cleanupを行います。version確定済みでjournalだけが残る場合は、値を確認してcleanupします。元値と変更後値のどちらにも一致しない項目や、予期しないversionは `MIGRATION_CONFLICT` で停止し、journalを残します。競合値を無条件に上書き・巻き戻ししません。原因を調査し、バックアップとjournalを見て利用側が解決してください。

通常のCRUDでは全領域snapshotやjournalを新規作成しません。復旧確認に必要な内部キーだけを読みます。metadata・journalは公開CRUD/watch/bridgeから隠します。watchはネイティブ変更単位で届き、移行全体を単一イベントにはまとめません。

## syncと保証の範囲

local/sessionのjournalは対応areaに保存し、syncのjournalは端末local、versionはsyncへ保存します。syncでmigrateする場合は `allowNonAtomicSync: true` が必須です。

```ts
await webextStorage<Schema>({ area: 'sync' }).namespace('settings').migrate({
  version: 1,
  allowNonAtomicSync: true,
  steps: { 1: draft => draft.set('theme', 'light') },
})
```

Web Locksは同一originの協調writerを調停します。複数API呼び出しを伴うため、移行はトランザクションではありません。直接nativeへ書くコード、別ライブラリ、同期サーバー、OS障害はロック外です。syncの端末間順序や原子性を保証せず、journalも端末内の復旧支援に限定します。version直前の再検査でも、直後の外部競合を完全には防げません。

通常/privateプロファイル間のstorageとLockの共有範囲、実端末間同期、実際のSW強制停止からの復旧は今回未検証です。Chromeの別context間ロックと実APIによる永続journal復旧はfixtureで確認しています。詳細は [検証結果](testing.md) を参照してください。強い保証が必要な設定にはlocalを選択してください。
