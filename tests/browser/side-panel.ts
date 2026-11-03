import type { SidePanelEvent } from '../../src/side-panel'

import { nativeMethod } from '../../src/internal/browser'
import { isWebextError, webextSidePanel as panel } from '../../src/side-panel'

declare const TEST_ORIGIN: string
const url = (path: string) => String(nativeMethod('runtime', 'getURL')?.(path))
const opened: SidePanelEvent[] = [],
  closed: SidePanelEvent[] = []
let stopOpened = () => {},
  stopClosed = () => {}
let windowId = 0

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
async function until(check: () => boolean, message: string) {
  const deadline = Date.now() + 4000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timeout: ${message}`)
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

/** Every step runs identically in Chrome and Firefox. */
async function expectOpen(count: number) {
  await until(() => opened.length > count, 'opened event')
  assert(opened.at(-1)?.windowId === windowId, 'Opened event window')
  assert(
    opened.at(-1)?.page === url('panel.html?global#route'),
    'Event page keeps the query and hash'
  )
  assert(await panel.isOpen(), 'isOpen() after open')
  assert(await panel.isOpen({ windowId }), 'isOpen({ windowId }) after open')
}
async function expectClosed(count: number) {
  await until(() => closed.length > count, 'closed event')
  assert(closed.at(-1)?.windowId === windowId, 'Closed event window')
  assert(!(await panel.isOpen()), 'isOpen() after close')
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
// Each step starts inside a trusted click handler, without a preceding await.
const steps: [string, () => Promise<void>][] = [
  [
    'sidePanel:open',
    async () => {
      const count = opened.length
      await panel.open()
      await expectOpen(count)
    },
  ],
  [
    'sidePanel:close',
    async () => {
      const count = closed.length
      await panel.close()
      await expectClosed(count)
    },
  ],
  [
    'sidePanel:toggle-open',
    async () => {
      const count = opened.length
      await panel.toggle()
      await expectOpen(count)
    },
  ],
  [
    'sidePanel:toggle-close',
    async () => {
      const count = closed.length
      await panel.toggle()
      await expectClosed(count)
    },
  ],
  [
    'sidePanel:open-window',
    async () => {
      const count = opened.length
      await panel.open({ windowId })
      await expectOpen(count)
    },
  ],
  [
    'sidePanel:close-window',
    async () => {
      const count = closed.length
      await panel.close({ windowId })
      await expectClosed(count)
    },
  ],
  [
    'sidePanel:unsubscribe',
    async () => {
      stopOpened()
      stopOpened()
      stopClosed()
      stopClosed()
      const count = opened.length + closed.length
      await panel.open()
      await new Promise((resolve) => setTimeout(resolve, 300))
      assert(opened.length + closed.length === count, 'Unsubscribed event')
      assert(await panel.isOpen(), 'Open without listeners')
    },
  ],
  [
    'sidePanel:close-final',
    async () => {
      await panel.close()
      assert(!(await panel.isOpen()), 'Closed at the end')
    },
  ],
]
button.addEventListener('click', () => {
  const step = steps[next++]
  if (!step) return
  button.disabled = true
  void (async () => {
    await report(step[0], step[1])
    status.textContent = `Completed ${step[0]}\nNext: ${steps[next]?.[0] ?? 'done'}`
    button.dataset.step = String(next)
    button.disabled = next >= steps.length
    await fetch(`${TEST_ORIGIN}/ready`, { method: 'POST', body: String(next) })
  })()
})

void (async () => {
  await report('sidePanel:configuration', async () => {
    const tab = (await nativeMethod('tabs', 'getCurrent')?.()) as {
      windowId: number
    }
    windowId = tab.windowId
    assert((await panel.getPage()) === url('panel.html'), 'Manifest page')
    await panel.setPage('panel.html?global#route')
    assert(
      (await panel.getPage()) === url('panel.html?global#route'),
      'Normalized page'
    )
    await panel.resetPage()
    assert((await panel.getPage()) === url('panel.html'), 'Reset page')
    await panel.setPage('panel.html?global#route')
    await rejects(
      () => panel.setPage('https://example.com'),
      'INVALID_ARGUMENT'
    )
    assert(!(await panel.isOpen({ windowId })), 'Initially closed')
    stopOpened = panel.onOpened((event) => opened.push(event))
    stopClosed = panel.onClosed((event) => closed.push(event))
  })
  await report('sidePanel:no-gesture', async () => {
    await rejects(() => panel.open({ windowId }), 'USER_GESTURE_REQUIRED')
    assert(!(await panel.isOpen({ windowId })), 'Still closed')
  })
  button.dataset.step = '0'
  button.disabled = false
  await fetch(`${TEST_ORIGIN}/ready`, { method: 'POST', body: '0' })
  status.textContent = `Ready: ${navigator.userAgent}`
})()
