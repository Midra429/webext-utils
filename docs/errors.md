# エラー

このライブラリの失敗はすべて `WebextError` です。`code` で原因を判別します。

```ts
import { isWebextError } from '@midra/webext-utils'

try {
  await messaging.send('settings:get')
} catch (error) {
  if (isWebextError(error)) {
    error.code // 'NO_RECEIVER' など
    error.operation // 失敗した操作（例: 'messaging', 'sidePanel.open'）
    error.cause // ブラウザ API の元のエラー（ある場合）
    error.details // 補足情報（ある場合）
  }
}
```

`WebextError` / `isWebextError` / `ErrorCode` は、ルートとすべてのサブパスから import できます。

## コード一覧

| コード | 意味 | 対処 |
| --- | --- | --- |
| `UNSUPPORTED_OPERATION` | その実行場所・環境で使えない操作 | Manifest の設定と実行場所を確認する |
| `CONTEXT_UNAVAILABLE` | 実行場所を特定できない、必要な前提がない | 拡張機能のページ・Background で呼ぶ。必要なら `webextContext.register()` |
| `PERMISSION_DENIED` | 権限が不足している | Manifest の `permissions` を確認する |
| `USER_GESTURE_REQUIRED` | ユーザー操作の外で呼ばれた | クリックなどのハンドラー内で `await` を挟まずに呼ぶ |
| `INVALID_ARGUMENT` | 引数が不正、登録が重複している | 引数と登録を見直す |
| `SERIALIZATION_ERROR` | JSON 互換ではない値 | `Date` などを文字列や数値に変換する |
| `VALIDATION_ERROR` | validator が拒否した、受信データの形式が不正 | 値と validator を確認する |
| `ACCESS_DENIED` | 公開ポリシー・送信元の検査で拒否された | MAIN world の公開設定や `contentScriptAccess` を確認する |
| `NO_RECEIVER` | 宛先に受信ハンドラーがない | 受信側の `on()` と `ready()` を確認する。必要なら `ignoreMissing` |
| `AMBIGUOUS_TARGET` | 単一宛先の送信で複数一致した | 宛先に `windowId` / `frameId` などを追加する |
| `TIMEOUT` | 期限内に応答がない | `timeoutMs` を見直す。副作用のある要求を自動で再送しない |
| `TRANSPORT_CLOSED` | 接続が切れた、解除・破棄された | 受信側が閉じていないか確認する |
| `ROUTER_UNAVAILABLE` | Background のルーターが動いていない | Background で `webextMessaging.startBackground()` を呼ぶ |
| `HANDLER_ERROR` | 受信ハンドラーが例外を投げた | 受信側のハンドラーを修正する |
| `MIGRATION_FAILED` | 移行ステップが失敗した | `details.step` と `cause` を確認する |
| `SCHEMA_TOO_NEW` | 保存済みのバージョンが移行計画より新しい | 拡張機能のバージョンを確認する |
| `MIGRATION_CONFLICT` | 移行中のデータが外部から変更された | データとジャーナルを確認して解決する |
| `TAB_NOT_FOUND` / `WINDOW_NOT_FOUND` | 対象のタブ・ウィンドウが存在しない | 閉じられたものとして扱う |
| `QUOTA_EXCEEDED` | 容量・件数・頻度の上限を超えた | 保存量や要求数を減らす |
| `NATIVE_ERROR` | 上記以外のブラウザ API の失敗 | `cause` を確認する |

## 通信をまたぐエラー

messaging でハンドラーから返ったエラーは、`code` と `message` だけが送信側に届きます（`cause` やスタックトレースは送りません）。MAIN world に返すエラーは、コードと定型のメッセージだけです。
