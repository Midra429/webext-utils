import { nativeMethod, object } from '../../src/internal/native'
import { webextMessaging } from '../../src/messaging'

const messaging = webextMessaging<{ where: { data: void; response: number } }>()
messaging.on('where', async () => {
  const tab = object(await nativeMethod('tabs', 'getCurrent')?.())
  if (typeof tab?.windowId !== 'number') throw Error('Missing current window')
  return tab.windowId
})
void (async () => {
  await messaging.ready()
  await nativeMethod('runtime', 'sendMessage')?.({ reviewReady: true })
})()
