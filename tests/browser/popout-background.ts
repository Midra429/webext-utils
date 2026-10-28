import type { PopoutHandle } from '../../src/popout'

import { webextContext } from '../../src/context'
import { nativeMethod, object } from '../../src/internal/native'
import {
  POPOUT_KEY_PREFIX,
  POPOUT_PARAM,
} from '../../src/internal/popout-record'
import { webextMessaging } from '../../src/messaging'
import { webextPopout } from '../../src/popout'
import { PopoutManager } from '../../src/popout/manager'
import { webextStorage } from '../../src/storage'

declare const TEST_ORIGIN: string
webextContext.register({ kind: 'background' })
webextMessaging.startBackground()
webextPopout.startBackground()
webextStorage.startBackground()
const reports: Record<string, unknown>[] = []
const epoch = crypto.randomUUID()
const contentReady = new Set<number>()
nativeMethod('runtime', 'onMessage', 'addListener')!(
  (value: unknown, sender: unknown, reply: (value: unknown) => void) => {
    const v = object(value)
    if (v?.fixture === 'popout-view') reports.push(v)
    if (v?.fixture === 'epoch') reply(epoch)
    if (v?.fixture === 'content-ready')
      contentReady.add(object(object(sender)?.tab)?.id as number)
  }
)
const call = async (path: string[], ...args: unknown[]) =>
  (await nativeMethod(...path)!(...args)) as Record<string, unknown>
function assert(value: unknown, message = 'Assertion failed'): asserts value {
  if (!value) throw Error(message)
}
async function wait<T>(read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const value = read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  throw Error('View report timeout')
}
async function test(name: string, run: () => Promise<void>) {
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
let first: PopoutHandle, panel: PopoutHandle
let associated: number, source: number
async function run() {
  const flag = '__webext_popout_fixture_started'
  if ((await call(['storage', 'session', 'get'], flag))[flag]) return
  await call(['storage', 'session', 'set'], { [flag]: true })
  await test('popup native discovery, bounds and source configuration', async () => {
    const a = await call(['tabs', 'create'], {
        url: `${TEST_ORIGIN}/target`,
        active: false,
      }),
      b = await call(['tabs', 'create'], { url: 'about:blank', active: false })
    for (const tab of [a, b]) {
      for (let i = 0; i < 100; i++) {
        if ((await call(['tabs', 'get'], tab.id)).status === 'complete') break
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }
    associated = a.id as number
    source = b.id as number
    await wait(() => (contentReady.has(associated) ? true : undefined))
    await call(['action', 'setPopup'], {
      tabId: source,
      popup: 'ui.html?mode=override#route',
    })
    first = await webextPopout.open({
      source: 'popup',
      sourceTarget: { tabId: source },
      associatedTabId: associated,
      reuseKey: 'first',
    })
    assert(first.page.endsWith('/ui.html?mode=override#route'))
    assert(
      first.associatedTabId === associated &&
        first.sourceTarget?.tabId === source
    )
    assert(first.bounds.width! > 0 && first.bounds.height! > 0)
    assert(
      (await nativeMethod('action', 'getPopup')!({ tabId: source })) ===
        first.page
    )
    const firefox = !!nativeMethod('sidebarAction', 'getPanel')
    if (firefox)
      await call(['action', 'setPopup'], {
        windowId: b.windowId,
        popup: 'ui.html?mode=window',
      })
    else await call(['tabs', 'update'], source, { active: true })
    const windowSource = await webextPopout.open({
      source: 'popup',
      sourceTarget: { windowId: b.windowId as number },
    })
    const expected = await nativeMethod('action', 'getPopup')!(
      firefox ? { windowId: b.windowId } : { tabId: source }
    )
    assert(windowSource.page === expected)
    assert(
      firefox
        ? windowSource.sourceTarget?.windowId === b.windowId
        : windowSource.sourceTarget?.tabId === source
    )
    await windowSource.close()
  })
  await test('same HTML self identity and getCurrent via internal RPC', async () => {
    const report = await wait(() =>
      reports.find((r) => r.windowId === first.windowId)
    )
    assert(
      report.current === first.windowId &&
        report.kind === 'popout' &&
        report.echo === 'hello:isolated',
      JSON.stringify(report)
    )
  })
  await test('concurrent reuse and explicit duplicate windows', async () => {
    const [a, b] = await Promise.all([
      webextPopout.open({
        source: 'popup',
        page: first.page,
        sourceTarget: { tabId: source },
        associatedTabId: associated,
        reuseKey: 'first',
      }),
      webextPopout.open({
        source: 'popup',
        page: first.page,
        sourceTarget: { tabId: source },
        associatedTabId: associated,
        reuseKey: 'first',
        width: 900,
      }),
    ])
    assert(a.windowId === first.windowId && b.windowId === first.windowId)
    const other = await webextPopout.open({ source: 'popup', page: first.page })
    assert(other.windowId !== first.windowId)
    await other.close()
  })
  await test('sidebar native discovery and independent instance', async () => {
    panel = await webextPopout.open({ source: 'sidePanel' })
    assert(panel.page.endsWith('/panel.html'))
    const report = await wait(() =>
      reports.find((r) => r.windowId === panel.windowId)
    )
    assert(report.kind === 'popout' && report.current === panel.windowId)
    assert(!(await panel.tabExists()))
  })
  await test('reload restores identity from session', async () => {
    const report = reports.find((r) => r.windowId === first.windowId)!
    reports.splice(reports.indexOf(report), 1)
    await call(['tabs', 'reload'], report.tabId)
    const restored = await wait(() =>
      reports.find((r) => r.windowId === first.windowId)
    )
    assert(restored.kind === 'popout' && restored.current === first.windowId)
  })
  await test('fresh manager restores ready and interrupted pending records', async () => {
    const saved = await call(['storage', 'session', 'get'], null)
    const [key, record] = Object.entries(saved).find(
      ([k, v]) =>
        k.startsWith(POPOUT_KEY_PREFIX) &&
        object(v)?.windowId === panel.windowId
    )!
    const pending: Record<string, unknown> = {
      ...object(record),
      status: 'pending',
    }
    delete pending.windowId
    delete pending.tabId
    await call(['storage', 'session', 'set'], { [key]: pending })
    const fresh = new PopoutManager(),
      restored = await fresh.get(panel.windowId)
    assert(restored?.windowId === panel.windowId && restored.status === 'ready')
  })
  await test('copied token is rejected in another native tab', async () => {
    const live = await call(['windows', 'get'], first.windowId, {
      populate: true,
    })
    const url = (live.tabs as { url: string }[])[0]!.url
    const copy = await call(['tabs', 'create'], { url, active: false })
    const report = await wait(() => reports.find((r) => r.tabId === copy.id))
    assert(
      report.current === null && report.kind === 'unknown',
      JSON.stringify(report)
    )
    await call(['tabs', 'remove'], copy.id)
  })
  await test('associated tab movement uses latest window', async () => {
    const moved = await call(['windows', 'create'], {
      tabId: associated,
      type: 'normal',
      focused: false,
    })
    assert((await first.getTab()).windowId === moved.id)
    await first.activateTab()
    assert((await first.getTab()).active)
    assert((await call(['windows', 'get'], moved.id)).focused)
  })
  await test('closed association stays fixed, only existence becomes false', async () => {
    await call(['tabs', 'remove'], associated)
    assert(!(await first.tabExists()))
    assert(first.associatedTabId === associated)
    try {
      await first.getTab()
      throw Error('Expected missing tab')
    } catch (error) {
      assert(object(error)?.code === 'TAB_NOT_FOUND', String(error))
    }
  })
  await test('navigation ends management without closing unrelated page', async () => {
    const own = await call(['windows', 'get'], panel.windowId, {
      populate: true,
    })
    const tab = (own.tabs as { id: number }[])[0]!
    await call(['tabs', 'update'], tab.id, {
      url: nativeMethod('runtime', 'getURL')!('other.html'),
    })
    await wait(() =>
      reports.find((r) => r.tabId === tab.id && r.current === null)
    )
    assert((await webextPopout.get(panel.windowId)) === undefined)
    await webextPopout.close(panel.windowId)
    assert(
      (await call(['windows', 'get'], panel.windowId)).id === panel.windowId
    )
    await call(['windows', 'remove'], panel.windowId)
  })
  await test('external URL, reserved token and incompatible reuse rejected', async () => {
    for (const opts of [
      { source: 'popup', page: 'https://example.com' },
      { source: 'popup', page: `ui.html?${POPOUT_PARAM}=forged` },
      { source: 'sidePanel', reuseKey: 'first' },
    ]) {
      try {
        await webextPopout.open(opts as never)
        throw Error('Expected rejection')
      } catch (error) {
        assert(object(error)?.code === 'INVALID_ARGUMENT', String(error))
      }
    }
  })
  await test('close cleanup and original UI outcome', async () => {
    const extra = await webextPopout.open({
      source: 'popup',
      page: 'ui.html',
      closeOriginal: true,
    })
    assert(extra.originalUiClose.status === 'unsupported')
    await extra.close()
    await first.close()
    assert((await webextPopout.get(first.windowId)) === undefined)
    const saved = await call(['storage', 'session', 'get'], null)
    assert(!Object.keys(saved).some((k) => k.startsWith(POPOUT_KEY_PREFIX)))
    if (!nativeMethod('sidebarAction', 'getPanel')) {
      const restartTab = await call(['tabs', 'create'], {
        url: `${TEST_ORIGIN}/target`,
        active: false,
      })
      await wait(() =>
        contentReady.has(restartTab.id as number) ? true : undefined
      )
      const restart = await webextPopout.open({
        source: 'popup',
        page: 'ui.html?restart=1',
        associatedTabId: restartTab.id as number,
      })
      await wait(() => reports.find((r) => r.windowId === restart.windowId))
    }
  })
}
void run().catch(console.error)
