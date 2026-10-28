import { nativeMethod } from '../../src/internal/native'
import { webextMessaging } from '../../src/messaging'
import { webextStorage } from '../../src/storage'
import { JOURNAL, META } from '../../src/storage/common'
import { bridgeResult } from './bridge'
import { testOrigin } from './report'

type Schema = {
  'fixture.content.theme': string
  'fixture.public.theme': 'dark' | 'light'
  'fixture.public.language': string
  'fixture.public.secret': string
  'fixture.race.count': number
}
type Messages = { 'storage:begin-race': { data: void; response: void } }
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
function check(v: boolean, detail = ''): void {
  if (!v) throw Error(`Storage fixture assertion failed: ${detail}`)
}
async function until(run: () => boolean): Promise<void> {
  for (let n = 0; n < 100; n++) {
    if (run()) return
    await delay(20)
  }
  throw Error('Storage event timed out')
}
export function storageBackground(): Promise<void> {
  webextStorage.startBackground()
  const messaging = webextMessaging<Messages>()
  messaging.on('storage:begin-race', async () => {
    let entered!: () => void
    const begun = new Promise<void>((resolve) => {
      entered = resolve
    })
    const task = webextStorage<Schema>()
      .namespace('fixture.race')
      .migrate({
        version: 1,
        steps: {
          1: async (d) => {
            entered()
            await delay(150)
            d.set('count', 1)
          },
        },
      })
    void task.catch(() => {})
    await begun
  })
  return (async () => {
    await bridgeResult('storage:native-areas', async () => {
      for (const area of ['local', 'sync', 'session'] as const) {
        const storage = webextStorage<{ 'fixture.native.value': string }>({
          area,
        })
        await storage.set('fixture.native.value', area)
        check((await storage.get('fixture.native.value')) === area)
        await storage.remove('fixture.native.value')
        check((await storage.get('fixture.native.value')) === undefined)
      }
    })
    await bridgeResult('storage:prototype-keys', async () => {
      for (const area of ['local', 'sync', 'session'] as const) {
        const storage = webextStorage<{
          'fixture.intrinsic.toString': string
          toString: string
        }>({ area })
        for (const key of ['fixture.intrinsic.toString', 'toString'] as const) {
          check(
            (await storage.get(key)) === undefined,
            `${area}.${key}: initial`
          )
          await storage.set(key, area)
          const actual = await storage.get(key)
          if (actual !== area) {
            // Keep a failing regression visible even when the native API also
            // loses the key. Do not accept this as a successful library read.
            await nativeMethod('storage', area, 'set')?.({ [key]: area })
            const raw = await nativeMethod('storage', area, 'get')?.(null)
            const nativeKeys = await nativeMethod(
              'storage',
              area,
              'getKeys'
            )?.()
            throw Error(
              `${area}.${key}: saved ${JSON.stringify(actual)}, native ${JSON.stringify(raw)}, keys ${JSON.stringify(nativeKeys)}`
            )
          }
          check(
            actual === area,
            `${area}.${key}: saved ${JSON.stringify(actual)}`
          )
          await storage.remove(key)
          check(
            (await storage.get(key)) === undefined,
            `${area}.${key}: removed`
          )
        }
      }
    })
    await bridgeResult('storage:native-watch', async () => {
      const storage = webextStorage<{ 'fixture.watch.value': string }>()
      const events: unknown[] = []
      const stop = storage.watch('fixture.watch.value', (e) => events.push(e))
      try {
        check(events.length === 0)
        await storage.set('fixture.watch.value', 'one')
        await storage.set('fixture.watch.value', 'one')
        await storage.remove('fixture.watch.value')
        await until(() => events.length >= 2)
        check(events.length === 2)
      } finally {
        stop()
      }
    })
    await bridgeResult('storage:journal-recovery', async () => {
      // A persisted interrupted journal exercises recovery with real native API calls.
      await nativeMethod(
        'storage',
        'local',
        'set'
      )?.({
        [JOURNAL]: {
          id: crypto.randomUUID(),
          prefix: 'fixture.recovery',
          from: 0,
          to: 1,
          entries: [{ key: 'fixture.recovery.value', after: 'recovered' }],
        },
      })
      const storage = webextStorage<{ 'fixture.recovery.value': string }>()
      check((await storage.get('fixture.recovery.value')) === 'recovered')
      const saved = (await nativeMethod(
        'storage',
        'local',
        'get'
      )?.([JOURNAL, META])) as Record<string, unknown>
      check(
        saved[JOURNAL] === undefined &&
          (saved[META] as Record<string, unknown>)['fixture.recovery'] === 1
      )
    })
  })()
}
export async function storageView(): Promise<void> {
  await bridgeResult('storage:context-lock', async () => {
    const messaging = webextMessaging<Messages>()
    try {
      await messaging.notify('storage:begin-race')
      const storage = webextStorage<Schema>().namespace('fixture.race')
      let ran = false
      const result = await storage.migrate({
        version: 1,
        steps: {
          1: (d) => {
            ran = true
            d.set('count', 99)
          },
        },
      })
      check(
        result.applied.length === 0 &&
          !ran &&
          (await storage.get('count')) === 1
      )
    } finally {
      messaging.dispose()
    }
  })
}
export async function storageIsolated(): Promise<void> {
  const messaging = webextMessaging()
  const bridge = messaging.installPageBridge({
    channel: 'fixture-storage',
    allowedOrigins: [testOrigin],
    fromPage: {},
    toPage: {},
  })
  webextStorage<Schema>()
    .namespace('fixture.public')
    .exposeToPage(bridge, {
      read: ['theme', 'language'],
      write: ['theme'],
      watch: ['theme'],
      validate: {
        theme: (v): v is 'light' | 'dark' => v === 'light' || v === 'dark',
        language: (v): v is string => typeof v === 'string',
      },
    })
  await bridgeResult('storage:content-rpc', async () => {
    const storage = webextStorage<Schema>().namespace('fixture.content')
    const events: unknown[] = []
    const stop = storage.watch('theme', (e) => events.push(e))
    try {
      await stop.ready
      await storage.set('theme', 'content')
      check((await storage.get('theme')) === 'content')
      await until(() => events.length === 1)
      await storage.remove('theme')
      await until(() => events.length === 2)
      let denied = false
      try {
        await webextStorage<Schema>({ area: 'session' }).get(
          'fixture.content.theme'
        )
      } catch (error) {
        denied =
          error instanceof Error &&
          'code' in error &&
          error.code === 'ACCESS_DENIED'
      }
      check(denied)
    } finally {
      stop()
    }
  })
}
export async function storageMain(): Promise<void> {
  const storage = webextStorage<Schema>({
    bridge: { channel: 'fixture-storage' },
  })
  await bridgeResult('storage:main-policy', async () => {
    await storage.set('fixture.public.theme', 'dark')
    check((await storage.get('fixture.public.theme')) === 'dark')
    let denied = 0
    for (const op of [
      () => storage.get('fixture.public.secret'),
      () =>
        storage.setMany({
          'fixture.public.theme': 'light',
          'fixture.public.language': 'en',
        }),
    ]) {
      try {
        await op()
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'ACCESS_DENIED'
        )
          denied++
      }
    }
    check(
      denied === 2 && (await storage.get('fixture.public.theme')) === 'dark'
    )
  })
  await bridgeResult('storage:main-watch', async () => {
    const events: unknown[] = []
    const stop = storage
      .namespace('fixture.public')
      .watchAll(['theme'], (e) => events.push(e))
    try {
      await stop.ready
      await storage.set('fixture.public.theme', 'light')
      await until(() => events.length === 1)
      check((events[0] as { key: string }).key === 'theme')
    } finally {
      stop()
    }
  })
}
