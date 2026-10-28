import { nativeMethod } from '../../src/internal/native'
import { webextMessaging } from '../../src/messaging'
import { webextStorage } from '../../src/storage'

const messaging = webextMessaging<{
  'popout:echo': { data: { value: string }; response: string }
}>()
const storage = webextStorage<{ 'popout.lifecycle.last': string }>()
messaging.on('popout:echo', async ({ value }) => {
  await storage.set('popout.lifecycle.last', `${value}:isolated`)
  return (await storage.get('popout.lifecycle.last'))!
})
void (async () => {
  await messaging.ready()
  await nativeMethod('runtime', 'sendMessage')!({ fixture: 'content-ready' })
})().catch(console.error)
