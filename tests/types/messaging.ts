import type {
  Delivery,
  MessageSender,
  MessageTarget,
  NotificationReport,
} from '@midra/webext-utils/messaging'

import { webextMessaging } from '@midra/webext-utils/messaging'

declare global {
  interface WebextMessages {
    'settings:get': { data: void; response: { theme: 'light' | 'dark' } }
    'page:title': { data: void; response: string }
    'page:highlight': { data: { selector: string }; response: void }
    'ui:changed': { data: { theme: 'light' | 'dark' }; response: void }
    optional: { data: { value: number } | undefined; response: number }
  }
}
const messaging = webextMessaging()
const title: string = await messaging.send('page:title')
const optional: number = await messaging.send('optional')
const changed: void = await messaging.notify('ui:changed', { theme: 'light' })
const report: NotificationReport = await messaging.notifyAll(
  'ui:changed',
  { theme: 'dark' },
  { target: { context: 'popup' } }
)
const stop = messaging.on('page:title', (_data, sender) => {
  const native: MessageSender = sender
  void native
  return 'title'
})
messaging.on('settings:get', async () => ({ theme: 'dark' as const }))
const delivered: Delivery<string> = await messaging.send(
  'page:title',
  undefined,
  { ignoreMissing: true }
)
const ordinary: string = await messaging.send('page:title', undefined, {
  ignoreMissing: false,
})
declare const flag: boolean
const dynamic: string | Delivery<string> = await messaging.send(
  'page:title',
  undefined,
  { ignoreMissing: flag }
)
// @ts-expect-error boolean flags must account for the result wrapper
const unsafe: string = await messaging.send('page:title', undefined, {
  ignoreMissing: flag,
})
// @ts-expect-error unknown names do not widen to string
messaging.send('missing:name')
// @ts-expect-error required data cannot be omitted
messaging.send('page:highlight')
// @ts-expect-error incorrect payload
messaging.send('page:highlight', { selector: 123 })
// @ts-expect-error notifications require response void
messaging.notify('page:title')
// @ts-expect-error notifyAll requires explicit target
messaging.notifyAll('ui:changed', { theme: 'dark' })
// @ts-expect-error wrong handler response
messaging.on('page:title', () => 123)
// @ts-expect-error async handler response is checked
messaging.on('page:title', async () => 123)
// @ts-expect-error wrong void handler response
messaging.on('ui:changed', () => 123)
// @ts-expect-error wrong handler parameter
messaging.on('page:highlight', (_data: number) => {})
messaging.send('page:title', undefined, {
  // @ts-expect-error background target cannot include tabId
  target: { context: 'background', tabId: 1 },
})
messaging.send('page:title', undefined, {
  // @ts-expect-error content script requires tabId
  target: { context: 'content-script' },
})
// @ts-expect-error view target cannot include frameId
const bad: MessageTarget = { context: 'popup', frameId: 0 }
const frame: MessageTarget = {
  context: 'content-script',
  world: 'ISOLATED',
  tabId: 1,
  frameId: 0,
  documentId: 'doc',
  instanceId: 'instance',
}
const main: MessageTarget = {
  context: 'content-script',
  world: 'MAIN',
  tabId: 1,
}
const override = webextMessaging<{
  'page:title': { data: { trim: boolean }; response: { text: string } }
  own: { data: void; response: boolean }
}>()
const overridden: { text: string } = await override.send(
  'page:title',
  { trim: true },
  { target: frame }
)
const inherited: { theme: 'light' | 'dark' } =
  await override.send('settings:get')
const own: boolean = await override.send('own')
// @ts-expect-error overridden name now requires data
override.send('page:title')
// @ts-expect-error overridden response replaces global response
const old: string = await override.send('page:title', { trim: true })
void [
  title,
  optional,
  changed,
  report,
  stop,
  delivered,
  ordinary,
  dynamic,
  unsafe,
  bad,
  main,
  overridden,
  inherited,
  own,
  old,
]

const page = webextMessaging({ bridge: { channel: 'public' } })
const pageTitle: string = await page.send('page:title')
const bridge = messaging.installPageBridge({
  channel: 'public',
  allowedOrigins: ['https://example.com'],
  fromPage: {
    'ui:changed': {
      target: { context: 'background' },
      validateData: (v: unknown): v is { theme: 'light' | 'dark' } =>
        typeof v === 'object' &&
        v !== null &&
        'theme' in v &&
        (v.theme === 'light' || v.theme === 'dark'),
      validateResponse: (v: unknown): v is void => v === undefined,
    },
  },
  toPage: {
    'page:title': {
      validateData: (v: unknown): v is void => v === undefined,
      validateResponse: (v: unknown): v is string => typeof v === 'string',
    },
  },
  limits: {
    maxBytes: 65536,
    maxDepth: 32,
    maxPending: 32,
    requestsPerMinute: 60,
  },
})
bridge.dispose()
messaging.installPageBridge({
  channel: 'public',
  allowedOrigins: [],
  fromPage: {},
  toPage: {
    // @ts-expect-error both validators are required, including void data
    'page:title': {
      validateResponse: (v: unknown): v is string => typeof v === 'string',
    },
  },
})
messaging.installPageBridge({
  channel: 'public',
  allowedOrigins: [],
  fromPage: {},
  toPage: {
    'page:title': {
      validateData: (v: unknown): v is void => v === undefined,
      // @ts-expect-error validator response must match the message contract
      validateResponse: (v: unknown): v is number => typeof v === 'number',
    },
  },
})
messaging.installPageBridge({
  channel: 'public',
  allowedOrigins: [],
  fromPage: {},
  toPage: {
    // @ts-expect-error policy names must be known
    missing: {
      validateData: (v: unknown): v is void => v === undefined,
      validateResponse: (v: unknown): v is void => v === undefined,
    },
  },
})
void pageTitle
