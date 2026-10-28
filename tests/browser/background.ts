import { webextContext } from '../../src/context'
import { nativeMethod } from '../../src/internal/native'
import {
  POPOUT_KEY_PREFIX,
  POPOUT_PARAM,
} from '../../src/internal/popout-record'
import { bridgeBackground } from './bridge'
import { backgroundMessaging } from './messaging'
import { report, testOrigin } from './report'
import { storageBackground } from './storage'

backgroundMessaging()
bridgeBackground()
const storageReady = storageBackground()

const url = (page: string) => String(nativeMethod('runtime', 'getURL')?.(page))

void (async () => {
  await storageReady
  await report('background', () => webextContext.resolve(), 'background')
  await nativeMethod('tabs', 'create')?.({ url: url('shared.html') })
  await nativeMethod('tabs', 'create')?.({ url: url('options.html') })
  await nativeMethod('tabs', 'create')?.({ url: `${testOrigin}/page` })
  // Keep the content document focused until its MAIN/ISOLATED tests finish.
  // Creating a focused popup at document_start can throttle its handshake timers.
  for (let n = 0; n < 300; n++) {
    if (await (await fetch(`${testOrigin}/ready-for-popout`)).json()) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const token = crypto.randomUUID()
  const key = `${POPOUT_KEY_PREFIX}${token}`
  const page = url('shared.html#route')
  const record = {
    version: 1,
    status: 'pending',
    token,
    source: 'sidePanel',
    page,
  }
  await nativeMethod('storage', 'session', 'set')?.({ [key]: record })
  const target = new URL(page)
  target.searchParams.set(POPOUT_PARAM, token)
  const created = await nativeMethod(
    'windows',
    'create'
  )?.({ type: 'popup', url: target.href })
  const window = created as { id: number; tabs: { id: number }[] }
  await nativeMethod(
    'storage',
    'session',
    'set'
  )?.({
    [key]: {
      ...record,
      status: 'ready',
      windowId: window.id,
      tabId: window.tabs[0]?.id,
    },
  })
})()
