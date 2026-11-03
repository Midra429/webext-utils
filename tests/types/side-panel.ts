import type {
  SidePanelEvent,
  SidePanelListener,
  SidePanelPageTarget,
  Subscription,
  Unsubscribe,
} from '@midra/webext-utils/side-panel'

import { webextSidePanel } from '@midra/webext-utils/side-panel'

const opening: Promise<void> = webextSidePanel.open()
void opening
void webextSidePanel.open({ windowId: 2 })
void webextSidePanel.close()
void webextSidePanel.toggle({ windowId: 2 })
const open: Promise<boolean> = webextSidePanel.isOpen()
void open
void webextSidePanel.setPage('panel.html')
void webextSidePanel.resetPage()
const page: Promise<string> = webextSidePanel.getPage()
void page

const listener: SidePanelListener = (event: SidePanelEvent) => {
  const windowId: number = event.windowId
  const url: string = event.page
  void [windowId, url]
}
const stop: Unsubscribe = webextSidePanel.onOpened(listener)
stop()
webextSidePanel.onClosed(({ windowId }) => void windowId)()

const registration: Subscription = webextSidePanel.registerPanel()
const ready: Promise<void> = registration.ready
void ready
registration()

const stopBackground: Unsubscribe = webextSidePanel.startBackground({
  openOnActionClick: true,
  onError: (error) => {
    const code: string = error.code
    void code
  },
})
stopBackground()

// @ts-expect-error tab scope differs between browsers and is not supported
void webextSidePanel.open({ tabId: 1 })
// @ts-expect-error numeric IDs
void webextSidePanel.open({ windowId: '1' })
void webextSidePanel.setPage('panel.html', { tabId: 1 })
void webextSidePanel.setPage('panel.html', { windowId: 2 })
const target: SidePanelPageTarget = { tabId: 1 }
const tabPage: Promise<string> = webextSidePanel.getPage(target)
void tabPage
void webextSidePanel.resetPage({ windowId: 2 })
// @ts-expect-error page targets are exclusive
void webextSidePanel.setPage('panel.html', { tabId: 1, windowId: 2 })
// @ts-expect-error an empty target is not a page target
void webextSidePanel.getPage({})
// @ts-expect-error URL strings only
void webextSidePanel.setPage(null)
// @ts-expect-error listener receives event objects
webextSidePanel.onClosed((value: number) => void value)
// @ts-expect-error boolean option
webextSidePanel.startBackground({ openOnActionClick: 'yes' })
