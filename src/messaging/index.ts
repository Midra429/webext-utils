/**
 * Background・Content Script・拡張機能のページの間で、型付きのメッセージを送受信するモジュールです。
 *
 * @module
 */
import type { Unsubscribe } from '../internal/types'
import type { RuntimePolicy } from './page/bridge'
import type {
  MessagingClient,
  MessagingOptions,
  PageBridgeOptions,
  SendOptions,
} from './types'

import { currentHub as current } from './hub'
import { IsolatedBridge } from './page/bridge'
import { PageClient } from './page/client'
import { DEFAULT_TIMEOUT, deadline, fail } from './protocol'

export type { ErrorCode, WebextErrorOptions } from '../internal/errors'
export type { JsonValue } from '../internal/json'
export type { Subscription, Unsubscribe } from '../internal/types'
export type {
  BackgroundTarget,
  ContentScriptTarget,
  Delivery,
  MessageData,
  MessageHandler,
  MessageMap,
  MessageName,
  MessageResponse,
  MessageSender,
  MessageTarget,
  MessagingClient,
  MessagingOptions,
  NotificationName,
  NotificationReport,
  PageBridge,
  PageBridgeOptions,
  PageMessageRule,
  ResolvedMessages,
  SendOptions,
  ViewTarget,
  ViewTargetContext,
} from './types'

export { WebextError, isWebextError } from '../internal/errors'

/**
 * 型付きのメッセージ送受信クライアントを作成します。
 *
 * 作成するだけではブラウザ API に触れません。Background では
 * {@link startBackground} の登録が必要です。
 *
 * @typeParam Override メッセージの型定義。グローバルの `WebextMessages` と統合されます
 * @param options MAIN world で使う場合のブリッジ設定
 *
 * @example
 * ```ts
 * import { webextMessaging } from '@midra/webext-utils/messaging'
 *
 * type Messages = {
 *   'app:version': { data: void; response: string }
 * }
 *
 * const messaging = webextMessaging<Messages>()
 * const version = await messaging.send('app:version')
 * ```
 */
function create<Override = {}>(
  options: MessagingOptions = {}
): MessagingClient<Override> {
  if (options.bridge) return PageClient.create<Override>(options.bridge.channel)
  const owner = {}
  const cancellations = new Set<(error: ReturnType<typeof fail>) => void>()
  let disposed = false
  const bridges = new Set<IsolatedBridge>()
  function active(): void {
    if (disposed) throw fail('TRANSPORT_CLOSED', 'Messaging client disposed')
  }
  // The public generic contract is erased only at this runtime boundary. All
  // wire values remain unknown and are validated before crossing native APIs.
  const client = {
    async send(name: string, data?: unknown, options: SendOptions = {}) {
      active()
      return await current().send(name, data, options, 'send', cancellations)
    },
    async notify(name: string, data?: unknown, options: SendOptions = {}) {
      active()
      return await current().send(name, data, options, 'notify', cancellations)
    },
    async notifyAll(name: string, data: unknown, options: SendOptions) {
      active()
      return await current().send(name, data, options, 'all', cancellations)
    },
    on(
      name: string,
      handler: (data: unknown, sender: unknown) => unknown
    ): Unsubscribe {
      active()
      return current().on(owner, name, handler)
    },
    installPageBridge(options: PageBridgeOptions<Override>) {
      active()
      const bridge = new IsolatedBridge(
        current(),
        options as unknown as RuntimePolicy,
        undefined,
        () => bridges.delete(bridge)
      )
      bridges.add(bridge)
      return bridge
    },
    async ready(): Promise<void> {
      active()
      await deadline(
        current().ready(),
        Date.now() + DEFAULT_TIMEOUT,
        cancellations
      )
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      for (const bridge of bridges) bridge.dispose()
      bridges.clear()
      for (const cancel of cancellations)
        cancel(fail('TRANSPORT_CLOSED', 'Messaging client disposed'))
      cancellations.clear()
      current().dispose(owner)
    },
  }
  return client as unknown as MessagingClient<Override>
}
/**
 * Background でメッセージの中継（ルーター）を開始します。
 *
 * Background のスクリプトの最上位で、最初の `await` より前に呼び出してください
 * （Service Worker / イベントページの再起動ごとに必要です）。
 *
 * @returns ルーターを停止する関数
 * @throws {WebextError} Background 以外では `CONTEXT_UNAVAILABLE`、二重登録は `INVALID_ARGUMENT`
 *
 * @example
 * ```ts
 * // background.ts
 * webextMessaging.startBackground()
 * const messaging = webextMessaging<Messages>()
 * messaging.on('app:version', () => '1.0.0')
 * ```
 */
function startBackground(): Unsubscribe {
  return current().startBackground()
}

/**
 * 型付きのメッセージ送受信クライアントを作成する関数です。
 *
 * `webextMessaging<Messages>(options?)` でクライアントを作成し、
 * `webextMessaging.startBackground()` で Background のルーターを開始します。
 */
export const webextMessaging: typeof create & {
  startBackground: typeof startBackground
} = Object.assign(create, { startBackground })
