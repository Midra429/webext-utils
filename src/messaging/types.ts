import type { ErrorCode } from '../internal/errors'
import type { Unsubscribe } from '../internal/types'

declare global {
  /**
   * アプリケーション全体で共有するメッセージの型定義です。
   *
   * 宣言をマージすると、型引数なしの `webextMessaging()` でもメッセージ名と型が推論されます。
   * 各メッセージは `{ data: 送信データの型; response: 応答の型 }` で定義します。
   *
   * @example
   * ```ts
   * declare global {
   *   interface WebextMessages {
   *     'settings:get': { data: void; response: { theme: 'light' | 'dark' } }
   *     'ui:changed': { data: { theme: string }; response: void }
   *   }
   * }
   * ```
   */
  interface WebextMessages {}
}

/**
 * メッセージの型定義です。キーがメッセージ名、値が `{ data, response }` です。
 *
 * - `data`: 送信するデータの型。省略可能にする場合は `void` か `undefined` を含めます
 * - `response`: 受信側の応答の型。通知（`notify`）専用なら `void`
 *
 * @example
 * ```ts
 * type Messages = {
 *   'app:version': { data: void; response: string }
 *   'tab:highlight': { data: { selector: string }; response: boolean }
 * }
 * ```
 */
export type MessageMap = Record<string, { data: unknown; response: unknown }>

/** Background を宛先にします（既定の宛先）。 */
export interface BackgroundTarget {
  context: 'background'
  instanceId?: never
  tabId?: never
  windowId?: never
  frameId?: never
  documentId?: never
  world?: never
}

/**
 * Content Script を宛先にします。`tabId` は必須です。
 *
 * 単一の宛先に送る `send` / `notify` では、`frameId` を省略するとトップフレーム（`0`）を対象にします。
 */
export interface ContentScriptTarget {
  context: 'content-script'
  /** 宛先のタブ ID です。 */
  tabId: number
  /**
   * 宛先のワールドです。
   *
   * @default 'ISOLATED'
   */
  world?: 'ISOLATED' | 'MAIN'
  /** 宛先のフレーム ID です。`send` / `notify` では既定で `0` です。 */
  frameId?: number
  /** 宛先の文書 ID です。 */
  documentId?: string
  /** 宛先のインスタンス ID です。 */
  instanceId?: string
  windowId?: never
}

/** 拡張機能のページ（ポップアップ・サイドパネル・popout・タブなど）の種類です。 */
export type ViewTargetContext =
  | 'popup'
  | 'side-panel'
  | 'popout'
  | 'options'
  | 'extension-page'
  | 'devtools'

/** 拡張機能のページを宛先にします。指定した条件をすべて満たすページに届きます。 */
export interface ViewTarget {
  context: ViewTargetContext
  /** 宛先のページがあるウィンドウの ID です。 */
  windowId?: number
  /** 宛先のページがあるタブの ID です（popout の関連タブではありません）。 */
  tabId?: number
  /** 宛先のインスタンス ID です。 */
  instanceId?: string
  /** 宛先の文書 ID です。 */
  documentId?: string
  frameId?: never
  world?: never
}

/**
 * メッセージの宛先です。`context` で種類を選びます。
 *
 * @example
 * ```ts
 * { context: 'background' }
 * { context: 'content-script', tabId: 42 }
 * { context: 'side-panel', windowId: 1 }
 * ```
 */
export type MessageTarget = BackgroundTarget | ContentScriptTarget | ViewTarget

/** 受信ハンドラーに渡される送信元の情報です。ブラウザが確認した値だけを含みます。 */
export interface MessageSender {
  /** 送信元の大分類です。 */
  readonly context: 'background' | 'content-script' | 'extension-page'
  /** 送信元の拡張機能 ID です（常にこの拡張機能）。 */
  readonly id: string
  /**
   * 送信元の信頼度です。
   *
   * - `extension`: 拡張機能のコードからの送信
   * - `page`: MAIN world（Web ページと同じ権限）からブリッジ経由で届いた送信
   */
  readonly trust: 'extension' | 'page'
  readonly tabId?: number
  readonly frameId?: number
  readonly windowId?: number
  readonly documentId?: string
  readonly url?: string
}

/** `send` / `notify` のオプションです。 */
export interface SendOptions {
  /**
   * 宛先です。
   *
   * @default { context: 'background' }
   */
  target?: MessageTarget
  /**
   * 応答を待つ時間（ミリ秒）です。
   *
   * @default 10000
   */
  timeoutMs?: number
  /**
   * `true` にすると、受信側がない場合（`NO_RECEIVER`）に例外を投げず `{ delivered: false }` を返します。
   * 結果は {@link Delivery} 型になります。
   */
  ignoreMissing?: boolean
}

/** `ignoreMissing: true` を指定したときの結果です。 */
export type Delivery<T> =
  | { readonly delivered: true; readonly value: T }
  | { readonly delivered: false }

/** `notifyAll` の結果です。宛先に一致した受信側ごとの配信結果を持ちます。 */
export interface NotificationReport {
  readonly results: readonly (
    | { readonly instanceId: string; readonly delivered: true }
    | {
        readonly instanceId: string
        readonly delivered: false
        readonly error: { readonly code: ErrorCode; readonly message: string }
      }
  )[]
}

/** 型引数 `O` とグローバルの {@link WebextMessages} を統合したメッセージ型です。 */
export type ResolvedMessages<O> = Omit<WebextMessages, keyof O> & O

/** メッセージ名の一覧です。 */
export type MessageName<M> = {
  [K in keyof M]: M[K] extends { data: unknown; response: unknown } ? K : never
}[keyof M] &
  string

/** メッセージ `K` の送信データの型です。 */
export type MessageData<M, K extends PropertyKey> = K extends keyof M
  ? M[K] extends { data: infer D }
    ? D
    : never
  : never

/** メッセージ `K` の応答の型です。 */
export type MessageResponse<M, K extends PropertyKey> = K extends keyof M
  ? M[K] extends { response: infer R }
    ? R
    : never
  : never

/** 応答が `void` のメッセージ名（`notify` で送れる名前）です。 */
export type NotificationName<M> = {
  [K in MessageName<M>]: [MessageResponse<M, K>] extends [void] ? K : never
}[MessageName<M>]

type Args<D, O> = undefined extends D
  ? [data?: D, options?: O]
  : void extends D
    ? [data?: D, options?: O]
    : [data: D, options?: O]
type AllArgs<D> = [
  data: D,
  options: Omit<SendOptions, 'ignoreMissing' | 'target'> & {
    target: MessageTarget
  },
]
type Result<R, O> = 'ignoreMissing' extends keyof O
  ? O extends { ignoreMissing: true }
    ? Delivery<R>
    : O extends { ignoreMissing: false | undefined }
      ? R
      : O extends { ignoreMissing?: infer I }
        ? true extends I
          ? R | Delivery<R>
          : R
        : R
  : R

/** メッセージ `K` の受信ハンドラーです。応答を返します（Promise も可）。 */
export type MessageHandler<M, K extends MessageName<M>> = (
  data: MessageData<M, K>,
  sender: MessageSender
) => MessageResponse<M, K> | Promise<MessageResponse<M, K>>

/**
 * 型付きのメッセージ送受信クライアントです。`webextMessaging()` で作成します。
 *
 * @typeParam O メッセージの型定義（{@link MessageMap}）。グローバルの {@link WebextMessages} と統合され、同名は `O` が優先されます
 */
export interface MessagingClient<O = {}> {
  /**
   * メッセージを送信し、応答を受け取ります。
   *
   * @param name メッセージ名
   * @param args 送信データと {@link SendOptions}。`data` が `void` の場合は省略できます
   * @returns 受信ハンドラーの応答。`ignoreMissing: true` の場合は {@link Delivery}
   * @throws {WebextError} `NO_RECEIVER` / `AMBIGUOUS_TARGET` / `TIMEOUT` / `HANDLER_ERROR` など
   *
   * @example
   * ```ts
   * const settings = await messaging.send('settings:get')
   * const title = await messaging.send('page:title', undefined, {
   *   target: { context: 'content-script', tabId: 42 },
   * })
   * ```
   */
  send<
    K extends MessageName<ResolvedMessages<O>>,
    const S extends SendOptions = {},
  >(
    name: K,
    ...args: Args<MessageData<ResolvedMessages<O>, K>, S>
  ): Promise<Result<MessageResponse<ResolvedMessages<O>, K>, S>>
  /**
   * 応答のない通知を送信します。受信ハンドラーの処理完了を待ちます。
   *
   * 応答の型が `void` のメッセージだけ送れます。
   */
  notify<
    K extends NotificationName<ResolvedMessages<O>>,
    const S extends SendOptions = {},
  >(
    name: K,
    ...args: Args<MessageData<ResolvedMessages<O>, K>, S>
  ): Promise<Result<void, S>>
  /**
   * 宛先に一致するすべての受信側へ通知します。`options.target` は必須です。
   *
   * @returns 受信側ごとの配信結果
   *
   * @example
   * ```ts
   * const report = await messaging.notifyAll('theme:changed', 'dark', {
   *   target: { context: 'content-script', tabId: 42 }, // 全フレーム
   * })
   * ```
   */
  notifyAll<K extends NotificationName<ResolvedMessages<O>>>(
    name: K,
    ...args: AllArgs<MessageData<ResolvedMessages<O>, K>>
  ): Promise<NotificationReport>
  /**
   * 受信ハンドラーを登録します。同じ JavaScript 環境で同じ名前は1つだけ登録できます。
   *
   * Background 以外では、登録の完了を {@link ready} で待ってから送信側に知らせてください。
   *
   * @returns ハンドラーを解除する関数
   *
   * @example
   * ```ts
   * messaging.on('settings:get', async () => ({ theme: 'dark' }))
   * ```
   */
  on<K extends MessageName<ResolvedMessages<O>>>(
    name: K,
    handler: MessageHandler<ResolvedMessages<O>, K>
  ): Unsubscribe
  /**
   * ISOLATED world の Content Script で、MAIN world に公開するブリッジを設置します。
   *
   * 公開するメッセージ名・宛先・validator を明示したものだけが通信できます。
   * 詳しくは `docs/main-world.md` を参照してください。
   */
  installPageBridge(options: PageBridgeOptions<O>): PageBridge
  /** 受信ハンドラーの登録（Background への通知）が完了するまで待ちます。 */
  ready(): Promise<void>
  /** このクライアントのハンドラーとブリッジをすべて解除します。以後は使えません。 */
  dispose(): void
}

/** `webextMessaging()` のオプションです。 */
export interface MessagingOptions {
  /**
   * MAIN world で使う場合に、ISOLATED world が設置したブリッジのチャネルを指定します。
   *
   * チャネル名は通信の識別子であり、秘密情報や認証ではありません。
   */
  bridge?: { channel: string }
}

/** 設置したブリッジです。 */
export interface PageBridge {
  /** ブリッジを撤去します。 */
  dispose(): void
}

/**
 * ブリッジで公開するメッセージの validator です。
 *
 * どちらも型ガード関数で、`false` を返すか例外を投げると `VALIDATION_ERROR` になります。
 */
export interface PageMessageRule<D, R> {
  /** 送信データを検査します。 */
  validateData: (value: unknown) => value is D
  /** 応答を検査します。 */
  validateResponse: (value: unknown) => value is R
}

type Policy<M> = {
  [K in MessageName<M>]?: PageMessageRule<
    MessageData<M, K>,
    MessageResponse<M, K>
  >
}

/** `installPageBridge()` のオプションです。 */
export interface PageBridgeOptions<O = {}> {
  /** チャネル名です。MAIN world 側の `bridge.channel` と同じ値にします。 */
  channel: string
  /** ブリッジを有効にするページのオリジンです（例: `'https://example.com'`）。 */
  allowedOrigins: readonly string[]
  /** MAIN world から送信できるメッセージです。宛先は固定です。 */
  fromPage: {
    [K in MessageName<ResolvedMessages<O>>]?: NonNullable<
      Policy<ResolvedMessages<O>>[K]
    > & {
      target: MessageTarget
    }
  }
  /** MAIN world で受信できるメッセージです。 */
  toPage: Policy<ResolvedMessages<O>>
}
