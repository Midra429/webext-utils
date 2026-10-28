import type { Messages, Schema } from './shared'

import {
  webextContext,
  webextMessaging,
  webextStorage,
} from '@midra/webext-utils'

webextContext.register({ kind: 'content-script', world: 'MAIN' })
const messaging = webextMessaging<Messages>({
  bridge: { channel: 'example-public-v1' },
})
const settings = webextStorage<Schema>({
  bridge: { channel: 'example-public-v1' },
})
void (async () => {
  console.log(await messaging.send('settings:theme'))
  const stop = settings.watchAll(
    ['settings.theme'],
    (change) => console.log(change.newValue),
    { onError: console.error }
  )
  window.addEventListener('pagehide', stop, { once: true })
  await stop.ready
  console.log(await settings.get('settings.theme'))
})().catch(console.error)
// Only public data crosses this bridge. The channel is not authentication.
