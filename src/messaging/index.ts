import type { Unsubscribe } from '../internal/errors'
import type { RuntimePolicy } from './page-bridge'
import type {
  MessagingClient,
  MessagingOptions,
  PageBridgeOptions,
  SendOptions,
} from './types'

import { IsolatedBridge } from './page-bridge'
import { PageClient } from './page-client'
import { DEFAULT_TIMEOUT, deadline, fail } from './protocol'
import { currentRealm as current } from './shared'

export type { ErrorCode, Unsubscribe } from '../internal/errors'
export type { JsonValue } from '../internal/json'
export type {
  Delivery,
  MessageSender,
  MessageTarget,
  MessagingClient,
  MessagingOptions,
  NotificationReport,
  PageBridge,
  PageBridgeLimits,
  PageBridgeOptions,
  SendOptions,
} from './types'

export { WebextError, isWebextError } from '../internal/errors'

function create<Override = {}>(
  options: MessagingOptions = {}
): MessagingClient<Override> {
  if (options.bridge)
    return PageClient.create<Override>(
      options.bridge.channel,
      undefined,
      options.bridge.limits
    )
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
export const webextMessaging = Object.assign(create, {
  startBackground(): Unsubscribe {
    return current().startBackground()
  },
})
