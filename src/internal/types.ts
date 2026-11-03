/**
 * 登録した処理を解除する関数です。
 *
 * 何度呼び出しても安全です（2回目以降は何もしません）。
 *
 * @example
 * ```ts
 * const stop = messaging.on('ping', () => 'pong')
 * stop() // 受信を停止
 * ```
 */
export type Unsubscribe = () => void

/**
 * 非同期の登録処理を伴う購読です。
 *
 * 関数として呼び出すと購読を解除します（{@link Unsubscribe} と同じ）。
 * `ready` は登録の完了で解決し、登録に失敗した場合は `WebextError` で reject します。
 *
 * @example
 * ```ts
 * const subscription = storage.watch('theme', console.log)
 * await subscription.ready // 登録完了を待つ
 * subscription() // 解除
 * ```
 */
export interface Subscription {
  /** 購読を解除します。何度呼び出しても安全です。 */
  (): void
  /** 登録が完了すると解決する Promise です。解除後や失敗時は reject します。 */
  readonly ready: Promise<void>
}
