import type { Messages, Schema } from './shared'

import {
  webextMessaging,
  webextPopout,
  webextSidePanel,
  webextStorage,
} from '@midra/webext-utils'

// Register everything before the first await, on every Background start.
webextMessaging.startBackground()
webextStorage.startBackground()
webextPopout.startBackground()
webextSidePanel.startBackground()
webextSidePanel.onOpened(({ windowId }) =>
  console.log('panel opened', windowId)
)
webextSidePanel.onClosed(({ windowId }) =>
  console.log('panel closed', windowId)
)
const messaging = webextMessaging<Messages>()
const settings = webextStorage<Schema>().namespace('settings')
messaging.on('settings:theme', async () => {
  await initialized
  return (await settings.get('theme')) ?? 'light'
})
// Run migrations at an application-controlled time before concurrent CRUD.
const initialized = settings.migrate({
  version: 1,
  steps: {
    1: (draft) => {
      if (draft.get('theme') === undefined) draft.set('theme', 'light')
    },
  },
})
void initialized.catch(console.error)
