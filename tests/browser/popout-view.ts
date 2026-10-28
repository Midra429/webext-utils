import { webextContext } from '../../src/context'
import { nativeMethod } from '../../src/internal/native'
import { webextMessaging } from '../../src/messaging'
import { webextPopout } from '../../src/popout'
import { webextStorage } from '../../src/storage'

Reflect.set(globalThis, '__webextPopoutStageG', {
  async restore() {
    const handle = await webextPopout.getCurrent()
    const context = await webextContext.resolve()
    const epoch = await nativeMethod('runtime', 'sendMessage')!({
      fixture: 'epoch',
    })
    if (!handle) throw Error('Expected restart popout')
    const messaging = webextMessaging<{
      'popout:echo': { data: { value: string }; response: string }
    }>()
    try {
      const echo = await messaging.send(
        'popout:echo',
        { value: 'restart-check' },
        { target: handle.messageTarget() }
      )
      const stored = await webextStorage<{
        'popout.lifecycle.last': string
      }>().get('popout.lifecycle.last')
      return {
        windowId: handle.windowId,
        kind: context.kind,
        epoch,
        echo,
        stored,
      }
    } finally {
      messaging.dispose()
    }
  },
  async close() {
    await (await webextPopout.getCurrent())?.close()
  },
})

async function run() {
  const current = await webextPopout.getCurrent()
  const context = await webextContext.resolve()
  let echo: string | undefined
  if (current?.associatedTabId !== undefined) {
    const messaging = webextMessaging<{
      'popout:echo': { data: { value: string }; response: string }
    }>()
    try {
      echo = await messaging.send(
        'popout:echo',
        { value: 'hello' },
        { target: current.messageTarget() }
      )
    } finally {
      messaging.dispose()
    }
  }
  const tab = (await nativeMethod('tabs', 'getCurrent')!()) as {
    id: number
    windowId: number
  }
  await nativeMethod('runtime', 'sendMessage')!({
    fixture: 'popout-view',
    tabId: tab.id,
    windowId: tab.windowId,
    current: current?.windowId ?? null,
    kind: context.kind,
    ...(echo === undefined ? {} : { echo }),
  })
}
void run().catch(console.error)
