import { webextMessaging } from '../../src/messaging'
import { testOrigin } from './report'

type Messages = {
  'fixture:echo': { data: number; response: number }
  'fixture:view': { data: number; response: number }
  'fixture:content': { data: void; response: string }
  'fixture:notice': { data: void; response: void }
  'fixture:throw': { data: void; response: void }
  'fixture:view-ready': { data: void; response: void }
  'fixture:content-ready': { data: void; response: void }
}
async function result(name: string, run: () => Promise<void>): Promise<void> {
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
  if (!value) throw Error('Messaging assertion failed')
}
export function backgroundMessaging(): void {
  webextMessaging.startBackground()
  const messaging = webextMessaging<Messages>()
  messaging.on('fixture:echo', async (value) => {
    await new Promise((resolve) => setTimeout(resolve, (100 - value) % 10))
    return value
  })
  messaging.on('fixture:throw', () => {
    throw Error('handler fixture')
  })
  messaging.on('fixture:notice', () => {})
  messaging.on('fixture:view-ready', async (_data, from) => {
    await result('messaging:background-view', async () => {
      const values = await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          messaging.send('fixture:view', i, {
            target: {
              context: 'extension-page',
              ...(from.documentId ? { documentId: from.documentId } : {}),
            },
          })
        )
      )
      check(values.every((value, i) => value === i))
    })
  })
  messaging.on('fixture:content-ready', async (_data, from) => {
    await result('messaging:background-content', async () => {
      check(typeof from.tabId === 'number')
      const title = await messaging.send('fixture:content', undefined, {
        target: {
          context: 'content-script',
          tabId: from.tabId!,
          frameId: from.frameId ?? 0,
          ...(from.documentId ? { documentId: from.documentId } : {}),
        },
      })
      check(title === 'content-ok')
    })
  })
}
export async function viewMessaging(): Promise<void> {
  const messaging = webextMessaging<Messages>()
  messaging.on('fixture:view', async (value) => {
    await new Promise((resolve) => setTimeout(resolve, (100 - value) % 10))
    return value
  })
  await result('messaging:view', async () => {
    await messaging.ready()
    const values = await Promise.all(
      Array.from({ length: 100 }, (_, i) => messaging.send('fixture:echo', i))
    )
    check(values.every((value, i) => value === i))
    await messaging.notify('fixture:notice')
    try {
      await messaging.notify('fixture:throw', undefined, {
        ignoreMissing: true,
      })
      throw Error('Expected handler failure')
    } catch (error) {
      check(
        error instanceof Error &&
          'code' in error &&
          error.code === 'HANDLER_ERROR'
      )
    }
    const missing = await messaging.send('fixture:content', undefined, {
      target: { context: 'popup' },
      ignoreMissing: true,
    })
    check(!missing.delivered)
    await messaging.notify('fixture:view-ready')
  })
}
export async function contentMessaging(): Promise<void> {
  const messaging = webextMessaging<Messages>()
  messaging.on('fixture:content', () => 'content-ok')
  await result('messaging:isolated', async () => {
    await messaging.ready()
    check((await messaging.send('fixture:echo', 42)) === 42)
    await messaging.notify('fixture:content-ready')
  })
  // Keep the receiver alive for Background's reverse request; no heartbeat.
}
