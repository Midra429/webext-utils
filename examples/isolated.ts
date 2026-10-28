import type { Messages, Schema } from './shared'

import { webextMessaging, webextStorage } from '@midra/webext-utils'

const messaging = webextMessaging<Messages>()
messaging.on('page:title', () => document.title)
const bridge = messaging.installPageBridge({
  channel: 'example-public-v1',
  allowedOrigins: ['https://example.com'],
  fromPage: {
    'settings:theme': {
      target: { context: 'background' },
      validateData: (v): v is void => v === undefined,
      validateResponse: (v): v is 'light' | 'dark' =>
        v === 'light' || v === 'dark',
    },
  },
  toPage: {},
})
webextStorage<Schema>()
  .namespace('settings')
  .exposeToPage(bridge, {
    read: ['theme'],
    watch: ['theme'],
    validate: {
      theme: (v): v is 'light' | 'dark' => v === 'light' || v === 'dark',
    },
  })
// Keep the bridge alive for the document; it manages pagehide/BFCache itself.
