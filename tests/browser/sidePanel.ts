import type { SidePanelEvent } from '../../src/sidePanel'

import { nativeMethod } from '../../src/internal/native'
import { isWebextError, webextSidePanel as panel } from '../../src/sidePanel'

declare const TEST_ORIGIN: string
const isChrome = !!nativeMethod('sidePanel', 'getOptions')
const url = (path: string) => String(nativeMethod('runtime', 'getURL')?.(path))
const opened: SidePanelEvent[] = [],
  closed: SidePanelEvent[] = []
let stopOpened = () => {},
  stopClosed = () => {}
let tabId = 0,
  windowId = 0,
  otherWindowId = 0,
  otherTabId = 0

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
async function rejects(run: () => Promise<unknown>, code: string) {
  try {
    await run()
  } catch (error) {
    assert(
      isWebextError(error) && error.code === code,
      `Expected ${code}: ${String(error)}`
    )
    return
  }
  throw new Error(`Expected rejection: ${code}`)
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 4000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Native event timeout')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
async function report(name: string, run: () => Promise<void>) {
  try {
    await run()
    await fetch(`${TEST_ORIGIN}/report`, {
      method: 'POST',
      body: JSON.stringify({ name, passed: true }),
    })
  } catch (error) {
    await fetch(`${TEST_ORIGIN}/report`, {
      method: 'POST',
      body: JSON.stringify({ name, passed: false, error: String(error) }),
    })
  }
}

const button = document.createElement('button')
button.textContent = 'Run next side panel test'
// Fixed geometry lets native-input automation click the same visible control.
button.style.cssText = 'position:fixed;left:8px;top:8px;width:260px;height:40px'
button.disabled = true
document.body.append(button)
const status = document.createElement('pre')
status.setAttribute('role', 'status')
status.style.marginTop = '60px'
document.body.append(status)
let next = 0
const steps: [string, () => Promise<void>][] = [
  [
    'sidePanel:open-window',
    async () => {
      const count = opened.length
      // The first operation starts inside a trusted click handler.
      await panel.open(isChrome ? { windowId } : undefined)
      if (isChrome) {
        await until(() => opened.length > count)
        assert(opened.at(-1)?.windowId === windowId, 'Opened event window')
        const otherCount = opened.length
        await panel.open({ windowId: otherWindowId })
        await until(() => opened.length > otherCount)
        assert(
          opened.at(-1)?.windowId === otherWindowId,
          'Explicit other-window open'
        )
        const closedCount = closed.length
        await panel.close({ windowId: otherWindowId })
        await until(() => closed.length > closedCount)
        assert(
          closed.at(-1)?.windowId === otherWindowId,
          'Explicit other-window close'
        )
      } else {
        assert(
          (await panel.getState({ windowId })).state === 'open',
          'Native open state'
        )
        assert(
          (await panel.getState({ windowId: otherWindowId })).state ===
            'closed',
          'Other window remains closed'
        )
      }
    },
  ],
  [
    'sidePanel:close-window',
    async () => {
      const count = closed.length
      await panel.close(isChrome ? { windowId } : undefined)
      if (isChrome) await until(() => closed.length > count)
      else
        assert(
          (await panel.getState({ windowId })).state === 'closed',
          'Native closed state'
        )
    },
  ],
  [
    'sidePanel:open-default',
    async () => {
      const count = opened.length
      await panel.open()
      if (isChrome) await until(() => opened.length > count)
      else
        assert(
          (await panel.getState({ windowId })).state === 'open',
          'Default open state'
        )
    },
  ],
  [
    'sidePanel:close-default',
    async () => {
      const count = closed.length
      await panel.close()
      if (isChrome) await until(() => closed.length > count)
    },
  ],
  [
    'sidePanel:open-after-await',
    async () => {
      const count = opened.length
      await nativeMethod('windows', 'getLastFocused')?.()
      if (isChrome) {
        await panel.open()
        await until(() => opened.length > count)
      } else {
        await rejects(() => panel.open(), 'USER_GESTURE_REQUIRED')
        assert(
          (await panel.getState({ windowId })).state === 'closed',
          'Rejected open kept sidebar closed'
        )
      }
    },
  ],
  [
    'sidePanel:close-after-await',
    async () => {
      const count = closed.length
      if (!isChrome) await panel.open()
      await nativeMethod('windows', 'getLastFocused')?.()
      if (isChrome) {
        await panel.close()
        await until(() => closed.length > count)
      } else {
        await rejects(() => panel.close(), 'USER_GESTURE_REQUIRED')
        assert(
          (await panel.getState({ windowId })).state === 'open',
          'Rejected close kept sidebar open'
        )
      }
    },
  ],
  [
    'sidePanel:tab-close-boundary',
    async () => {
      // With only global configuration, native close(tabId) must reject on 145+.
      // On 142-144 the library rejects before calling native close.
      await panel.open()
      const count = closed.length
      if (!isChrome) {
        await rejects(() => panel.close({ tabId }), 'UNSUPPORTED_OPERATION')
      } else if (!panel.getCapabilities().close.tab) {
        await rejects(() => panel.close({ tabId }), 'UNSUPPORTED_OPERATION')
      } else {
        await rejects(() => panel.close({ tabId }), 'NATIVE_ERROR')
      }
      await new Promise((resolve) => setTimeout(resolve, 150))
      assert(closed.length === count, 'Another panel was closed')
      if (isChrome && !panel.getCapabilities().close.tab) {
        // Native 142-144 closes the global panel here; the wrapper must not.
        await nativeMethod('sidePanel', 'close')?.({ tabId })
        await until(() => closed.length > count)
        assert(
          closed.at(-1)?.tabId === undefined,
          'Expected native global fallback'
        )
      }
    },
  ],
  [
    'sidePanel:open-tab',
    async () => {
      // Set configuration outside the next click's activation path.
      if (!isChrome) {
        await rejects(() => panel.open({ tabId }), 'UNSUPPORTED_OPERATION')
        return
      }
      const count = opened.length
      await panel.open({ tabId })
      await until(() => opened.length > count)
      assert(
        opened.at(-1)?.tabId === tabId,
        'Tab panel is a separate native instance even at the same path'
      )
      await nativeMethod('tabs', 'update')?.(otherTabId, { active: true })
      assert(
        (await panel.getState({ windowId })).state === 'unknown',
        'Tab switch cannot prove Chrome visibility'
      )
      await nativeMethod('tabs', 'update')?.(tabId, { active: true })
    },
  ],
  [
    'sidePanel:close-tab',
    async () => {
      if (!isChrome || !panel.getCapabilities().close.tab) {
        await rejects(() => panel.close({ tabId }), 'UNSUPPORTED_OPERATION')
        return
      }
      const count = closed.length
      await panel.close({ tabId })
      await until(() =>
        closed.slice(count).some((event) => event.tabId === tabId)
      )
      assert(
        closed.slice(count).some((event) => event.tabId === tabId),
        `Tab-specific close event: ${JSON.stringify(closed.slice(count))}`
      )
    },
  ],
  [
    'sidePanel:unsubscribe-state',
    async () => {
      stopOpened()
      stopOpened()
      stopClosed()
      stopClosed()
      const count = opened.length + closed.length
      await panel.open()
      await new Promise((resolve) => setTimeout(resolve, 150))
      assert(
        opened.length + closed.length === count,
        'Unsubscribed event delivered'
      )
      if (isChrome)
        assert(
          (await panel.getState({ windowId })).state === 'unknown',
          'Chrome must stay unknown'
        )
    },
  ],
]
button.addEventListener('click', () => {
  const step = steps[next++]
  if (!step) return
  button.disabled = true
  void (async () => {
    await report(step[0], step[1])
    if (next === 7) {
      await panel.setPage('panel.html?global#route', { tabId })
      assert(
        (await panel.getPage({ tabId })) === url('panel.html?global#route'),
        'Tab override'
      )
    }
    status.textContent = `Completed ${step[0]}\nNext: ${steps[next]?.[0] ?? 'done'}`
    button.dataset.step = String(next)
    button.disabled = next >= steps.length
    await fetch(`${TEST_ORIGIN}/ready`, { method: 'POST', body: String(next) })
  })()
})

void (async () => {
  await report('sidePanel:configuration', async () => {
    const tab = (await nativeMethod('tabs', 'getCurrent')?.()) as {
      id: number
      windowId: number
    }
    tabId = tab.id
    windowId = tab.windowId
    const otherWindow = (await nativeMethod(
      'windows',
      'create'
    )?.({ url: url('panel.html?other-window'), focused: false })) as {
      id: number
    }
    otherWindowId = otherWindow.id
    const otherTab = (await nativeMethod(
      'tabs',
      'create'
    )?.({ windowId, url: url('panel.html?other-tab'), active: false })) as {
      id: number
    }
    otherTabId = otherTab.id
    await nativeMethod('windows', 'update')?.(windowId, { focused: true })
    assert((await panel.getPage()) === url('panel.html'), 'Manifest page')
    await panel.setPage('panel.html?global#route')
    assert(
      (await panel.getPage()) === url('panel.html?global#route'),
      'Global normalized page'
    )
    assert(
      (await panel.getPage({ tabId })) === url('panel.html?global#route'),
      'Tab inherits global'
    )
    if (isChrome) {
      await rejects(
        () => panel.setPage('panel.html', { windowId }),
        'UNSUPPORTED_OPERATION'
      )
      stopOpened = panel.onOpened((event) => opened.push(event))
      stopClosed = panel.onClosed((event) => closed.push(event))
    } else {
      await panel.setPage('panel.html?window', { windowId })
      assert(
        (await panel.getPage({ windowId })) === url('panel.html?window'),
        'Window configuration'
      )
      for (const subscribe of [panel.onOpened, panel.onClosed]) {
        try {
          subscribe(() => {})
          throw new Error('Expected unsupported event')
        } catch (error) {
          assert(
            isWebextError(error) && error.code === 'UNSUPPORTED_OPERATION',
            String(error)
          )
        }
      }
    }
    await rejects(
      () => panel.setPage('https://example.com'),
      'INVALID_ARGUMENT'
    )
    const state = await panel.getState({ windowId })
    assert(
      state.state === (isChrome ? 'unknown' : 'closed'),
      'Initial visibility'
    )
  })
  await report('sidePanel:no-gesture', async () => {
    await rejects(
      () => panel.open(isChrome ? { windowId } : undefined),
      'USER_GESTURE_REQUIRED'
    )
  })
  button.dataset.step = '0'
  button.disabled = false
  await fetch(`${TEST_ORIGIN}/ready`, { method: 'POST', body: '0' })
  status.textContent = `Ready: ${navigator.userAgent}\n${JSON.stringify(panel.getCapabilities())}`
})()
