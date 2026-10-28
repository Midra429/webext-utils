// Consumes the built package through its real exports (no source alias).
import {
  webextContext,
  webextMessaging,
  webextPopout,
  webextSidePanel,
  webextStorage,
} from '@midra/webext-utils'

import { nativeMethod } from '../../src/internal/native'

declare const TEST_ORIGIN: string

type Messages = {
  'integration:inspect': {
    data: void
    response: { kind: string; theme: string; title: string; source: string }
  }
  'integration:title': { data: void; response: string }
  'integration:set': { data: string; response: void }
}
type Schema = { 'integration.theme': string }
const messaging = webextMessaging<Messages>()
const settings = webextStorage<Schema>().namespace('integration')
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function integrationContent() {
  messaging.on('integration:title', () => document.title)
}
export async function integrationView() {
  await webextPopout.getCurrent()
  await webextContext.resolve()
  messaging.on('integration:set', (value) => settings.set('theme', value))
  messaging.on('integration:inspect', async () => {
    const handle = await webextPopout.getCurrent()
    if (!handle) throw Error('Missing popout')
    const context = await webextContext.resolve()
    const title = await messaging.send('integration:title', undefined, {
      target: handle.messageTarget(),
    })
    return {
      kind: context.kind,
      theme: (await settings.get('theme'))!,
      title,
      source: handle.source,
    }
  })
  void messaging.ready()
}
export function integrationBackground() {
  // Register at evaluation time, before any await.
  webextMessaging.startBackground()
  webextStorage.startBackground()
  webextPopout.startBackground()
  void (async () => {
    const reports: { name: string; passed: boolean; error?: string }[] = []
    async function test(name: string, run: () => Promise<void>) {
      try {
        await run()
        reports.push({ name, passed: true })
      } catch (error) {
        reports.push({ name, passed: false, error: String(error) })
      }
    }
    let tabId: number | undefined
    const handles: Awaited<ReturnType<typeof webextPopout.open>>[] = []
    const ensure = (
      value: unknown,
      detail = 'Integration assertion failed'
    ) => {
      if (!value) throw Error(detail)
    }
    await test('integration:five-modules', async () => {
      ensure(
        (await webextContext.resolve()).kind === 'background',
        'Background context'
      )
      const tab = (await nativeMethod('tabs', 'create')!({
        url: `${TEST_ORIGIN}/target`,
      })) as { id: number }
      tabId = tab.id
      let ready = false
      for (let n = 0; n < 100; n++) {
        const result = await messaging.send('integration:title', undefined, {
          target: { context: 'content-script', tabId },
          ignoreMissing: true,
        })
        if (result.delivered) {
          ready = true
          break
        }
        await delay(30)
      }
      ensure(ready, 'Content receiver registration')
      await settings.migrate({
        version: 1,
        steps: { 1: (draft) => draft.set('theme', 'dark') },
      })
      const page = await webextSidePanel.getPage()
      ensure(page?.endsWith('/integrated.html'), `Panel page: ${page}`)
      for (const source of ['popup', 'sidePanel'] as const) {
        const handle = await webextPopout.open({
          source,
          associatedTabId: tabId,
        })
        handles.push(handle)
        ensure(handle.page === page, `Shared page: ${handle.page} vs ${page}`)
        let response: Messages['integration:inspect']['response'] | undefined
        for (let n = 0; n < 100; n++) {
          const result = await messaging.send(
            'integration:inspect',
            undefined,
            {
              target: { context: 'popout', windowId: handle.windowId },
              ignoreMissing: true,
            }
          )
          if (result.delivered) {
            response = result.value
            break
          }
          await delay(30)
        }
        ensure(
          response?.kind === 'popout' &&
            response.theme === 'dark' &&
            response.title === 'Associated tab fixture' &&
            response.source === source,
          `View response: ${JSON.stringify(response)} for ${source}`
        )
      }
    })
    await test('integration:cross-view-watch', async () => {
      ensure(handles.length === 2)
      const events: string[] = []
      const stop = settings.watch('theme', (e) => {
        if (e.newValue) events.push(e.newValue)
      })
      try {
        await messaging.notify('integration:set', 'light', {
          target: { context: 'popout', windowId: handles[0]!.windowId },
        })
        for (let n = 0; n < 100 && events.length === 0; n++) await delay(20)
        ensure(events.length === 1 && events[0] === 'light')
        for (const handle of handles) {
          const response = await messaging.send(
            'integration:inspect',
            undefined,
            { target: { context: 'popout', windowId: handle.windowId } }
          )
          ensure(response.theme === 'light')
        }
      } finally {
        stop()
      }
    })
    await test('integration:cleanup', async () => {
      for (const handle of handles) await handle.close()
      if (tabId !== undefined) await nativeMethod('tabs', 'remove')!(tabId)
      await settings.remove('theme')
      messaging.dispose()
    })
    for (const result of reports)
      await fetch(`${TEST_ORIGIN}/report`, {
        method: 'POST',
        body: JSON.stringify(result),
      })
  })()
}
