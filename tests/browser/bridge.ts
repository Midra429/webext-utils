import type { MessageTarget } from '../../src/messaging'

import { webextMessaging } from '../../src/messaging'
import { PAGE_PROTOCOL, eventName } from '../../src/messaging/page-wire'
import { testOrigin } from './report'

type Messages = {
  'bridge:view-ready': { data: void; response: void }
  'bridge:await-view': { data: void; response: void }
  'bridge:background': { data: number; response: number }
  'bridge:view': { data: number; response: number }
  'bridge:isolated': { data: number; response: number }
  'bridge:title': { data: void; response: string }
  'bridge:check': { data: void; response: void }
  'bridge:denied': { data: void; response: void }
  'bridge:configure': { data: number; response: void }
  'fixture:tab-id': { data: void; response: number }
  'bridge:isolated-checked': { data: void; response: void }
  'bridge:shutdown': { data: void; response: void }
}
const channel = 'fixture-public'
const number = (v: unknown): v is number => typeof v === 'number'
const none = (v: unknown): v is void => v === undefined
const string = (v: unknown): v is string => typeof v === 'string'
export async function bridgeResult(
  name: string,
  run: () => Promise<void>
): Promise<void> {
  try {
    await run()
    await fetch(`${testOrigin}/report`, {
      method: 'POST',
      body: JSON.stringify({ name, passed: true }),
    })
  } catch (error) {
    await fetch(`${testOrigin}/report`, {
      method: 'POST',
      body: JSON.stringify({ name, passed: false, error: String(error) }),
    })
  }
}
function check(value: boolean): void {
  if (!value) throw Error('Bridge assertion failed')
}
export function bridgeBackground(): void {
  const messaging = webextMessaging<Messages>()
  let resolveView!: () => void
  const viewReady = new Promise<void>((resolve) => {
    resolveView = resolve
  })
  messaging.on('bridge:view-ready', (_, sender) => {
    check(sender.trust === 'extension')
    resolveView()
  })
  messaging.on('bridge:await-view', () => viewReady)
  messaging.on('fixture:tab-id', (_, sender) => sender.tabId!)
  messaging.on('bridge:background', (value, sender) => {
    check(
      sender.trust === 'page' &&
        typeof sender.tabId === 'number' &&
        sender.frameId === 0
    )
    return value
  })
  messaging.on('bridge:check', async (_, sender) => {
    check(sender.trust === 'page')
    const target: MessageTarget = {
      context: 'content-script',
      world: 'MAIN',
      tabId: sender.tabId!,
      frameId: sender.frameId ?? 0,
      ...(sender.documentId ? { documentId: sender.documentId } : {}),
    }
    await bridgeResult('bridge:background-main', async () => {
      check(
        (await messaging.send('bridge:title', undefined, { target })) ===
          'main-ok'
      )
    })
    await messaging.notify('bridge:configure', sender.tabId!, {
      target: { context: 'extension-page' },
    })
  })
}
export async function bridgeView(): Promise<void> {
  const messaging = webextMessaging<Messages>()
  messaging.on('bridge:view', (value, sender) => {
    check(sender.trust === 'page')
    return value
  })
  messaging.on('bridge:configure', async (tabId) => {
    await bridgeResult('bridge:view-main', async () => {
      check(
        (await messaging.send('bridge:title', undefined, {
          target: { context: 'content-script', world: 'MAIN', tabId },
        })) === 'main-ok'
      )
    })
  })
  await messaging.ready()
  await messaging.notify('bridge:view-ready')
}
export async function bridgeIsolated(): Promise<void> {
  const messaging = webextMessaging<Messages>()
  messaging.on('bridge:isolated', (value, sender) => {
    check(sender.trust === 'page')
    return value
  })
  // Ask Background for the native tab ID without trusting a page-supplied ID.
  const tabId = await messaging.send('fixture:tab-id')
  const from = (target: MessageTarget) => ({
    target,
    validateData: number,
    validateResponse: number,
  })
  const bridge = messaging.installPageBridge({
    channel,
    allowedOrigins: [testOrigin],
    fromPage: {
      'bridge:background': from({ context: 'background' }),
      'bridge:view': from({ context: 'extension-page' }),
      'bridge:isolated': from({
        context: 'content-script',
        tabId,
        world: 'ISOLATED',
        frameId: 0,
      }),
      'bridge:await-view': {
        target: { context: 'background' },
        validateData: none,
        validateResponse: none,
      },
      'bridge:check': {
        target: { context: 'background' },
        validateData: none,
        validateResponse: none,
      },
      'bridge:isolated-checked': {
        target: {
          context: 'content-script',
          tabId,
          world: 'ISOLATED',
          frameId: 0,
        },
        validateData: none,
        validateResponse: none,
      },
      'bridge:shutdown': {
        target: {
          context: 'content-script',
          tabId,
          world: 'ISOLATED',
          frameId: 0,
        },
        validateData: none,
        validateResponse: none,
      },
    },
    toPage: {
      'bridge:title': { validateData: none, validateResponse: string },
    },
  })
  let finish!: () => void, checked!: () => void
  const finished = new Promise<void>((resolve) => {
    finish = resolve
  })
  const reverseChecked = new Promise<void>((resolve) => {
    checked = resolve
  })
  messaging.on('bridge:shutdown', () => {
    finish()
  })
  messaging.on('bridge:isolated-checked', () => reverseChecked)
  await bridgeResult('bridge:isolated-main', async () => {
    // MAIN announces readiness by initiating the allowed check; registration is
    // observed by bounded NO_RECEIVER retries in this fixture only.
    for (let attempt = 0; attempt < 100; attempt++) {
      const delivery = await messaging.send('bridge:title', undefined, {
        target: { context: 'content-script', world: 'MAIN', tabId },
        ignoreMissing: true,
      })
      if (delivery.delivered) {
        check(delivery.value === 'main-ok')
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw Error('MAIN did not register')
  })
  checked()
  await bridgeResult('bridge:cleanup', async () => {
    await finished
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await messaging.send('bridge:title', undefined, {
        target: { context: 'content-script', world: 'MAIN', tabId },
        ignoreMissing: true,
      })
      if (!result.delivered) {
        bridge.dispose()
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw Error('MAIN subscription survived dispose')
  })
}
export async function bridgeMain(): Promise<void> {
  let session = ''
  document.addEventListener(
    eventName(channel, true),
    (event) => {
      const value = JSON.parse((event as CustomEvent<string>).detail)
      if (value.type === 'hello') session = value.session
    },
    { once: true }
  )
  const messaging = webextMessaging<Messages>({ bridge: { channel } })
  messaging.on('bridge:title', () => 'main-ok')
  await bridgeResult('bridge:main-background', async () => {
    await messaging.ready()
    check((await messaging.send('bridge:background', 42)) === 42)
  })
  await bridgeResult('bridge:main-view', async () => {
    await messaging.notify('bridge:await-view')
    check((await messaging.send('bridge:view', 43)) === 43)
  })
  await bridgeResult('bridge:main-isolated', async () => {
    check((await messaging.send('bridge:isolated', 44)) === 44)
  })
  await bridgeResult('bridge:policy', async () => {
    for (const send of [
      () => messaging.notify('bridge:denied'),
      () =>
        messaging.send('bridge:background', 1, {
          target: { context: 'popup' },
        }),
    ]) {
      let denied = false
      try {
        await send()
      } catch (error) {
        denied =
          error instanceof Error &&
          'code' in error &&
          error.code === 'ACCESS_DENIED'
      }
      check(denied)
    }
    const forged = new Promise<void>((resolve, reject) => {
      const id = crypto.randomUUID()
      const timer = setTimeout(() => {
        document.removeEventListener(eventName(channel, false), receive)
        reject(Error('Forgery rejection timed out'))
      }, 1000)
      function receive(event: Event) {
        const value = JSON.parse((event as CustomEvent<string>).detail)
        if (value.id !== id) return
        clearTimeout(timer)
        document.removeEventListener(eventName(channel, false), receive)
        if (value.ok === false && value.error.code === 'ACCESS_DENIED')
          resolve()
        else reject(Error('Forged sender was accepted'))
      }
      document.addEventListener(eventName(channel, false), receive)
      document.dispatchEvent(
        new CustomEvent(eventName(channel, true), {
          detail: JSON.stringify({
            protocol: PAGE_PROTOCOL,
            version: 1,
            direction: 'from-page',
            type: 'request',
            session,
            id,
            name: 'bridge:background',
            mode: 'send',
            data: 1,
            sender: { id: 'forged', tabId: 123, trust: 'extension' },
          }),
        })
      )
    })
    await forged
    await messaging.notify('bridge:check')
  })

  await messaging.notify('bridge:isolated-checked')
  await messaging.notify('bridge:shutdown')
  messaging.dispose()
}
