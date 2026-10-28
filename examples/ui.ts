import type { Messages, Schema } from './shared'

import {
  isWebextError,
  webextContext,
  webextMessaging,
  webextPopout,
  webextSidePanel,
  webextStorage,
} from '@midra/webext-utils'

const output = document.querySelector<HTMLOutputElement>('#status')!
function showError(error: unknown) {
  output.value = isWebextError(error)
    ? `${error.code}: ${error.message}`
    : String(error)
}
const messaging = webextMessaging<Messages>()
const settings = webextStorage<Schema>().namespace('settings')
async function start() {
  // Verify the popout token before registering any receiving message handlers.
  const current = await webextPopout.getCurrent()
  const context = await webextContext.resolve()
  output.value = `${context.kind}: ${(await settings.get('theme')) ?? 'light'}`
  const stop = settings.watchAll(
    ['theme'],
    ({ newValue }) => {
      output.value = newValue ?? 'light'
    },
    { onError: showError }
  )
  await stop.ready
  document.querySelector('#theme')!.addEventListener('click', () => {
    void (async () => {
      const value = await settings.get('theme')
      await settings.set('theme', value === 'dark' ? 'light' : 'dark')
    })().catch(showError)
  })
  document.querySelector('#popout')!.addEventListener('click', () => {
    void webextPopout
      .open({
        source:
          current?.source ??
          (context.kind === 'side-panel' ? 'sidePanel' : 'popup'),
        reuseKey: 'example',
      })
      .catch(showError)
  })
  // Start the native operation directly within the click handler.
  document.querySelector('#panel')!.addEventListener('click', () => {
    void webextSidePanel.open().catch(showError)
  })
  document.querySelector('#title')!.addEventListener('click', () => {
    void (async () => {
      if (current?.associatedTabId === undefined) {
        output.value = 'Open a popout with associatedTabId to inspect a tab'
        return
      }
      output.value = await messaging.send('page:title', undefined, {
        target: current.messageTarget(),
      })
    })().catch(showError)
  })
  window.addEventListener(
    'pagehide',
    () => {
      stop()
      messaging.dispose()
    },
    { once: true }
  )
}
void start().catch(showError)
