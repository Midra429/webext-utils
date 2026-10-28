import type {
  SidePanelCapabilities,
  SidePanelEvent,
  SidePanelState,
  Unsubscribe,
} from '@midra/webext-utils/sidePanel'

import { webextSidePanel } from '@midra/webext-utils/sidePanel'

const opening: Promise<void> = webextSidePanel.open()
void opening
void webextSidePanel.close({ tabId: 1 })
void webextSidePanel.open({ windowId: 2 })
void webextSidePanel.setPage('panel.html')
void webextSidePanel.setPage('panel.html', { tabId: 1 })
void webextSidePanel.setPage('panel.html', { windowId: 2 })
const page: Promise<string | undefined> = webextSidePanel.getPage({ tabId: 1 })
void page
const capabilities: SidePanelCapabilities = webextSidePanel.getCapabilities()
const supported: boolean = capabilities.close.tab
void supported
const stop: Unsubscribe = webextSidePanel.onOpened((event: SidePanelEvent) => {
  const windowId: number = event.windowId
  const tabId: number | undefined = event.tabId
  const page: string = event.page
  void [windowId, tabId, page]
})
stop()
async function state() {
  const value: SidePanelState = await webextSidePanel.getState({ windowId: 2 })
  if (value.state === 'unknown') {
    const reason: 'NATIVE_STATE_UNAVAILABLE' = value.reason
    void reason
    // @ts-expect-error unknown has no native source
    void value.source
  } else {
    const source: 'native' = value.source
    void source
    // @ts-expect-error native state has no unknown reason
    void value.reason
  }
}
void state
// @ts-expect-error exclusive targets
void webextSidePanel.open({ tabId: 1, windowId: 2 })
const both = { tabId: 1, windowId: 2 }
// @ts-expect-error exclusive even when supplied through a variable
void webextSidePanel.close(both)
// @ts-expect-error explicit empty target is invalid
void webextSidePanel.open({})
// @ts-expect-error scope is exclusive
void webextSidePanel.setPage('panel.html', both)
// @ts-expect-error state needs a concrete window
void webextSidePanel.getState({ tabId: 1 })
// @ts-expect-error window is required
void webextSidePanel.getState()
// @ts-expect-error numeric IDs
void webextSidePanel.open({ windowId: '1' })
// @ts-expect-error undefined is not an explicit target
void webextSidePanel.close({ windowId: undefined })
// @ts-expect-error handler must accept event objects
webextSidePanel.onClosed((value: number) => void value)
// @ts-expect-error URL strings only
void webextSidePanel.setPage(null)
