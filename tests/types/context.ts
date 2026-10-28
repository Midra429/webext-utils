import type {
  ContextInfo,
  ContextRegistration,
  Unsubscribe,
} from '@midra/webext-utils/context'

import {
  WebextError,
  isWebextError,
  webextContext,
} from '@midra/webext-utils/context'

const info: ContextInfo = webextContext.get()
const pending: Promise<ContextInfo> = webextContext.resolve()
const stop: Unsubscribe = webextContext.register({
  kind: 'content-script',
  world: 'MAIN',
})
stop()
if (info.kind === 'popout') {
  const id: number = info.windowId
  const origin: 'popup' | 'sidePanel' = info.origin
  const associated: number | undefined = info.associatedTabId
  void [id, origin, associated]
}
if (info.kind === 'content-script') {
  const world: 'MAIN' | 'ISOLATED' = info.world
  void world
}
if (info.kind === 'background') {
  const implementation: 'service-worker' | 'page' = info.implementation
  void implementation
}
// @ts-expect-error popout-only metadata requires narrowing
info.origin
// @ts-expect-error window identity is optional outside the popout branch
const unsafe: number = info.windowId
// @ts-expect-error MAIN is not a standalone context kind
webextContext.register({ kind: 'MAIN' })
// @ts-expect-error execution world is required
webextContext.register({ kind: 'content-script' })
// @ts-expect-error identity cannot be supplied by registration
webextContext.register({ kind: 'popup', tabId: 123 })
// @ts-expect-error popout requires a verified record
webextContext.register({ kind: 'popout' })
// @ts-expect-error unknown cannot be registered
const registration: ContextRegistration = { kind: 'unknown' }
// @ts-expect-error public snapshots cannot be mutated
info.kind = 'popup'
const error: unknown = new WebextError('INVALID_ARGUMENT', 'example', 'bad')
if (isWebextError(error)) {
  const operation: string = error.operation
  void operation
}
void [pending, unsafe, registration]
