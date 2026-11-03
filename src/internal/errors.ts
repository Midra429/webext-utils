/**
 * {@link WebextError} の種類を表すコードです。
 *
 * | コード | 主な原因 |
 * | --- | --- |
 * | `UNSUPPORTED_OPERATION` | その実行場所・ブラウザで使えない操作、Web Locks などの前提機能がない |
 * | `CONTEXT_UNAVAILABLE` | 拡張機能の実行場所を特定できない、必要な前提（ページや設定）がない |
 * | `PERMISSION_DENIED` | Manifest の権限が不足している |
 * | `USER_GESTURE_REQUIRED` | ユーザー操作（クリックなど）の外で呼び出された |
 * | `INVALID_ARGUMENT` | 引数が不正、または同じ登録が重複している |
 * | `SERIALIZATION_ERROR` | JSON 互換ではない値を渡した |
 * | `VALIDATION_ERROR` | validator が値を拒否した、または受信データの形式が不正 |
 * | `ACCESS_DENIED` | 公開ポリシーや送信元の検査で拒否された |
 * | `NO_RECEIVER` | 宛先に一致する受信ハンドラーがない |
 * | `AMBIGUOUS_TARGET` | 単一宛先の送信で、複数の受信ハンドラーが一致した |
 * | `TIMEOUT` | 期限内に応答がなかった |
 * | `TRANSPORT_CLOSED` | 通信路が閉じた、または解除・破棄された |
 * | `ROUTER_UNAVAILABLE` | Background で `startBackground()` が登録されていない |
 * | `HANDLER_ERROR` | 受信ハンドラーが例外を投げた |
 * | `MIGRATION_FAILED` | 移行ステップが例外を投げた |
 * | `SCHEMA_TOO_NEW` | 保存済みのスキーマが移行計画より新しい |
 * | `MIGRATION_CONFLICT` | 移行中のデータが外部から変更された |
 * | `TAB_NOT_FOUND` / `WINDOW_NOT_FOUND` | 対象のタブ・ウィンドウが存在しない |
 * | `QUOTA_EXCEEDED` | 容量・件数・頻度の上限を超えた |
 * | `NATIVE_ERROR` | 上記に分類できないブラウザ API の失敗（`cause` に元のエラー） |
 */
export type ErrorCode =
  | 'UNSUPPORTED_OPERATION'
  | 'PERMISSION_DENIED'
  | 'NO_RECEIVER'
  | 'AMBIGUOUS_TARGET'
  | 'TIMEOUT'
  | 'CONTEXT_UNAVAILABLE'
  | 'INVALID_ARGUMENT'
  | 'SERIALIZATION_ERROR'
  | 'VALIDATION_ERROR'
  | 'ACCESS_DENIED'
  | 'HANDLER_ERROR'
  | 'TRANSPORT_CLOSED'
  | 'ROUTER_UNAVAILABLE'
  | 'MIGRATION_FAILED'
  | 'SCHEMA_TOO_NEW'
  | 'MIGRATION_CONFLICT'
  | 'TAB_NOT_FOUND'
  | 'WINDOW_NOT_FOUND'
  | 'QUOTA_EXCEEDED'
  | 'USER_GESTURE_REQUIRED'
  | 'NATIVE_ERROR'

/** {@link WebextError} の追加オプションです。 */
export interface WebextErrorOptions {
  /** 元になったエラーです。 */
  cause?: unknown
  /** エラーの補足情報です（例: 移行に失敗したステップ番号）。 */
  details?: Readonly<Record<string, unknown>>
}

/**
 * このライブラリが投げるすべてのエラーの型です。
 *
 * `code` で原因を判別できます。ブラウザ API の元のエラーは `cause` に保持します。
 *
 * @example
 * ```ts
 * try {
 *   await messaging.send('settings:get')
 * } catch (error) {
 *   if (isWebextError(error) && error.code === 'NO_RECEIVER') {
 *     // 受信側がまだ登録されていない
 *   }
 * }
 * ```
 */
export class WebextError extends Error {
  override readonly name = 'WebextError'

  /** 補足情報です。ない場合は `undefined` です。 */
  readonly details: Readonly<Record<string, unknown>> | undefined

  /**
   * @param code エラーの種類
   * @param operation 失敗した操作の名前（例: `'sidePanel.open'`）
   * @param message 説明
   * @param options `cause` と `details`
   */
  constructor(
    /** エラーの種類です。 */
    readonly code: ErrorCode,
    /** 失敗した操作の名前です（例: `'sidePanel.open'`, `'storage'`）。 */
    readonly operation: string,
    message: string,
    options?: WebextErrorOptions
  ) {
    super(message, options)
    this.details = options?.details
  }
}

/**
 * 値が {@link WebextError} かどうかを判定します。
 *
 * @example
 * ```ts
 * if (isWebextError(error)) console.error(error.code)
 * ```
 */
export function isWebextError(error: unknown): error is WebextError {
  return error instanceof WebextError
}

/** 任意の例外を `WebextError` に変換します（既に `WebextError` ならそのまま）。 */
export function nativeError(operation: string, cause: unknown): WebextError {
  return isWebextError(cause)
    ? cause
    : new WebextError(
        'NATIVE_ERROR',
        operation,
        `Native operation failed: ${operation}`,
        { cause }
      )
}

/** ブラウザのエラーメッセージから代表的な {@link ErrorCode} を推定します。 */
export function classifyNativeError(
  cause: unknown,
  fallback: ErrorCode = 'NATIVE_ERROR'
): ErrorCode {
  const message = cause instanceof Error ? cause.message : String(cause)
  if (GESTURE.test(message)) return 'USER_GESTURE_REQUIRED'
  if (PERMISSION.test(message)) return 'PERMISSION_DENIED'
  if (TAB.test(message)) return 'TAB_NOT_FOUND'
  if (WINDOW.test(message)) return 'WINDOW_NOT_FOUND'
  if (QUOTA.test(message)) return 'QUOTA_EXCEEDED'
  return fallback
}

const GESTURE =
  /(?:user gesture|user action|user activation|user input handler)/i
const PERMISSION =
  /(?:permission denied|missing.*permission|requires? .*permission|access denied|not allowed)/i
const TAB = /(?:no tab with id|invalid tab id)/i
const WINDOW = /(?:no window with id|invalid window id)/i
const QUOTA = /(?:quota|MAX_WRITE|MAX_ITEMS|exceed.*(?:bytes|storage))/i
