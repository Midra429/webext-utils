import { nativeMethod, object } from '../../src/internal/native'
import { webextMessaging } from '../../src/messaging'
import { webextStorage } from '../../src/storage'
import { JOURNAL, META } from '../../src/storage/common'
import { bridgeResult } from './bridge'

const messaging = webextMessaging<{ where: { data: void; response: number } }>()
webextMessaging.startBackground()
let loaded!: () => void
const ready = new Promise<void>((resolve) => {
  loaded = resolve
})
nativeMethod(
  'runtime',
  'onMessage',
  'addListener'
)?.((raw: unknown) => {
  if (object(raw)?.reviewReady) loaded()
})
function check(value: boolean): void {
  if (!value) throw Error('Final review regression assertion failed')
}
async function run(): Promise<void> {
  await bridgeResult('review:window-move', async () => {
    const window = object(
      await nativeMethod(
        'windows',
        'create'
      )?.({
        url: nativeMethod('runtime', 'getURL')?.('review.html'),
        focused: false,
      })
    )
    await ready
    const tab = object(Array.isArray(window?.tabs) ? window.tabs[0] : undefined)
    if (typeof window?.id !== 'number' || typeof tab?.id !== 'number')
      throw Error('Missing tab/window')
    await nativeMethod(
      'tabs',
      'create'
    )?.({ windowId: window.id, url: 'about:blank' })
    check(
      (await messaging.send('where', undefined, {
        target: { context: 'extension-page', windowId: window.id },
      })) === window.id
    )
    const moved = object(
      await nativeMethod(
        'windows',
        'create'
      )?.({ tabId: tab.id, focused: false })
    )
    if (typeof moved?.id !== 'number') throw Error('Missing moved window')
    let rejected = false
    try {
      await messaging.send('where', undefined, {
        target: { context: 'extension-page', windowId: window.id },
      })
    } catch (error) {
      rejected = object(error)?.code === 'NO_RECEIVER'
    }
    check(rejected)
    check(
      (await messaging.send('where', undefined, {
        target: {
          context: 'extension-page',
          windowId: moved.id,
          tabId: tab.id,
        },
      })) === moved.id
    )
    await nativeMethod('windows', 'remove')?.(window.id)
    await nativeMethod('windows', 'remove')?.(moved.id)
  })
  await bridgeResult('review:large-migration', async () => {
    const store = webextStorage<{
      'review.large.a': string
      'review.large.b': string
      'review.large.c': string
    }>().namespace('review.large')
    await store.set('a', 'a'.repeat(600000))
    await store.set('b', 'b'.repeat(600000))
    await store.migrate({ version: 1, steps: { 1: () => {} } })
    await store.migrate({
      version: 2,
      steps: {
        2: (draft) => {
          draft.set('a', 'x'.repeat(600000))
          draft.remove('b')
          draft.set('c', 'c'.repeat(600000))
        },
      },
    })
    check(
      (await store.get('a')) === 'x'.repeat(600000) &&
        (await store.get('b')) === undefined &&
        (await store.get('c'))?.length === 600000
    )
    // Persist an interrupted journal larger than the wire bound, then let CRUD
    // recover it through actual native storage rather than a fake transport.
    await nativeMethod(
      'storage',
      'local',
      'set'
    )?.({
      [JOURNAL]: {
        id: crypto.randomUUID(),
        prefix: 'review.large',
        from: 2,
        to: 3,
        entries: [
          {
            key: 'review.large.a',
            before: 'x'.repeat(600000),
            after: 'r'.repeat(600000),
          },
          { key: 'review.large.c', before: 'c'.repeat(600000) },
        ],
      },
    })
    check(
      (await store.get('a')) === 'r'.repeat(600000) &&
        (await store.get('c')) === undefined
    )
    const saved = object(
      await nativeMethod('storage', 'local', 'get')?.([JOURNAL, META])
    )
    check(
      saved?.[JOURNAL] === undefined &&
        object(saved?.[META])?.['review.large'] === 3
    )
  })
}
void run()
