import type { PopoutHandle, PopoutTab } from '@midra/webext-utils/popout'

import { webextMessaging } from '@midra/webext-utils/messaging'
import { webextPopout } from '@midra/webext-utils/popout'

const handle: PopoutHandle = await webextPopout.open({
  source: 'side-panel',
  associatedTabId: 7,
  width: 480,
  height: 720,
  reuseKey: 'inspector',
})
const tab: PopoutTab = await handle.getTab()
const url: string | undefined = tab.url
const exists: boolean = await handle.tabExists()
const current: PopoutHandle | undefined = await webextPopout.getCurrent()
const saved: PopoutHandle | undefined = await webextPopout.get(1)
const stop: () => void = webextPopout.startBackground()
await webextPopout.close(1)
await handle.activateTab()
await handle.close()
const messaging = webextMessaging<{ title: { data: void; response: string } }>()
const title: string = await messaging.send('title', undefined, {
  target: handle.messageTarget({ world: 'MAIN', documentId: 'doc' }),
})
void [url, exists, current, saved, stop, title]
if (handle.originalUiClose.status === 'failed') {
  const code: string = handle.originalUiClose.error.code
  void code
}
// @ts-expect-error source required
void webextPopout.open({ page: 'ui.html' })
// @ts-expect-error source is closed union
void webextPopout.open({ source: 'options' })
// source target is exclusive
void webextPopout.open({
  source: 'popup',
  // @ts-expect-error source target is exclusive
  sourceTarget: { tabId: 1, windowId: 2 },
})
void webextPopout.open({
  source: 'popup',
  sourceTarget: { tabId: 42 },
  closeOriginal: true,
})
// @ts-expect-error a side panel cannot be closed after opening a popout
void webextPopout.open({ source: 'side-panel', closeOriginal: true })
// @ts-expect-error side panel pages are global
void webextPopout.open({ source: 'side-panel', sourceTarget: { tabId: 1 } })
// @ts-expect-error the old camelCase name is not accepted
void webextPopout.open({ source: 'sidePanel' })
// @ts-expect-error moving an existing tab is not exposed
void webextPopout.open({ source: 'popup', tabId: 1 })
// @ts-expect-error IDs are numeric
void webextPopout.get('1')
// @ts-expect-error bounds are readonly
handle.bounds.width = 100
// @ts-expect-error association is readonly
handle.associatedTabId = 1
// @ts-expect-error world union
handle.messageTarget({ world: 'other' })
// @ts-expect-error frame IDs numeric
handle.messageTarget({ frameId: '0' })
// @ts-expect-error target does not take a replacement tab
handle.messageTarget({ tabId: 1 })
