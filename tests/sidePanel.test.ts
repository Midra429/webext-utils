import { afterEach, describe, expect, test } from 'bun:test'

import { webextSidePanel as panel } from '../src/sidePanel'

const restores: (() => void)[] = []
function global(name: string, value: unknown) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { value, configurable: true })
  restores.push(() =>
    descriptor
      ? Object.defineProperty(globalThis, name, descriptor)
      : Reflect.deleteProperty(globalThis, name)
  )
}
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore()
})
function fixture(kind: 'chrome' | 'firefox' = 'chrome', version = '156') {
  const calls: [string, unknown[]][] = []
  const root =
    kind === 'chrome' ? 'chrome-extension://self/' : 'moz-extension://self/'
  const pages = new Map<string, string>()
  let opened = false
  const key = (value: unknown) => JSON.stringify(value ?? {})
  function ev() {
    const callbacks = new Set<(info: unknown) => void>()
    const api = {
      addListener(callback: (info: unknown) => void) {
        expect(this).toBe(api)
        callbacks.add(callback)
      },
      removeListener(callback: (info: unknown) => void) {
        expect(this).toBe(api)
        callbacks.delete(callback)
      },
    }
    return {
      api,
      callbacks,
      emit: (info: unknown) => {
        for (const callback of callbacks) callback(info)
      },
    }
  }
  const onOpened = ev(),
    onClosed = ev()
  const chromePanel = {
    open(...args: unknown[]) {
      expect(this).toBe(chromePanel)
      calls.push(['open', args])
      return Promise.resolve()
    },
    close(...args: unknown[]) {
      expect(this).toBe(chromePanel)
      calls.push(['close', args])
      return Promise.resolve()
    },
    async setOptions(value: { path: string; tabId?: number }) {
      expect(this).toBe(chromePanel)
      calls.push(['setOptions', [value]])
      pages.set(
        key(value.tabId === undefined ? {} : { tabId: value.tabId }),
        value.path
      )
    },
    async getOptions(value: { tabId?: number }) {
      expect(this).toBe(chromePanel)
      calls.push(['getOptions', [value]])
      return { path: pages.get(key(value)) ?? pages.get('{}'), enabled: true }
    },
    onOpened: onOpened.api,
    onClosed: onClosed.api,
  }
  const sidebar = {
    open(...args: unknown[]) {
      expect(this).toBe(sidebar)
      calls.push(['open', args])
      opened = true
      return Promise.resolve()
    },
    close(...args: unknown[]) {
      expect(this).toBe(sidebar)
      calls.push(['close', args])
      opened = false
      return Promise.resolve()
    },
    async isOpen(value: unknown) {
      expect(this).toBe(sidebar)
      calls.push(['isOpen', [value]])
      return opened
    },
    async setPanel(value: {
      panel: string
      tabId?: number
      windowId?: number
    }) {
      expect(this).toBe(sidebar)
      calls.push(['setPanel', [value]])
      const { panel: page, ...target } = value
      pages.set(key(target), page)
    },
    async getPanel(value: unknown) {
      expect(this).toBe(sidebar)
      calls.push(['getPanel', [value]])
      return pages.get(key(value)) ?? pages.get('{}') ?? ''
    },
  }
  const windows = {
    async getLastFocused() {
      expect(this).toBe(windows)
      calls.push(['getLastFocused', []])
      return { id: 9 }
    },
  }
  const runtime = {
    getURL(path: string) {
      expect(this).toBe(runtime)
      return root + path
    },
  }
  global('navigator', { userAgent: `Mozilla/5.0 Chrome/${version}.0.0.0` })
  global(
    'chrome',
    kind === 'chrome' ? { runtime, sidePanel: chromePanel, windows } : undefined
  )
  global(
    'browser',
    kind === 'firefox' ? { runtime, sidebarAction: sidebar } : undefined
  )
  return {
    root,
    calls,
    pages,
    chromePanel,
    sidebar,
    windows,
    runtime,
    onOpened,
    onClosed,
  }
}

describe('sidePanel native controls', () => {
  test('SSR operations fail and capabilities are absent', async () => {
    global('chrome', undefined)
    global('browser', undefined)
    expect(panel.getCapabilities().open.activeWindow).toBe(false)
    await expect(panel.open()).rejects.toMatchObject({
      code: 'CONTEXT_UNAVAILABLE',
    })
    await expect(panel.getPage()).rejects.toMatchObject({
      code: 'CONTEXT_UNAVAILABLE',
    })
    await expect(panel.getState({ windowId: 1 })).rejects.toMatchObject({
      code: 'CONTEXT_UNAVAILABLE',
    })
    expect(() => panel.onOpened(() => {})).toThrow()
  })
  test('Chrome starts explicit operations synchronously without window lookup', async () => {
    const f = fixture()
    const pending = panel.open({ windowId: 3 })
    expect(f.calls).toEqual([['open', [{ windowId: 3 }]]])
    await pending
    await panel.close({ tabId: 8 })
    expect(f.calls[1]).toEqual(['close', [{ tabId: 8 }]])
  })
  test('active-window uses a concrete ID, never WINDOW_ID_CURRENT', async () => {
    const f = fixture()
    await panel.open()
    await panel.close()
    expect(f.calls).toEqual([
      ['getLastFocused', []],
      ['open', [{ windowId: 9 }]],
      ['getLastFocused', []],
      ['close', [{ windowId: 9 }]],
    ])
  })
  test('missing active-window resolution fails without opening', async () => {
    const f = fixture()
    global('chrome', { runtime: f.runtime, sidePanel: f.chromePanel })
    expect(panel.getCapabilities().open.activeWindow).toBe(false)
    await expect(panel.open()).rejects.toMatchObject({
      code: 'CONTEXT_UNAVAILABLE',
    })
    expect(f.calls).toEqual([])
    await panel.open({ windowId: 3 })
  })
  test.each(['142', '143', '144', 'unknown', ''])(
    'Chrome %s rejects tab close before side effects',
    async (version) => {
      const f = fixture('chrome', version)
      expect(panel.getCapabilities().close.tab).toBe(false)
      await expect(panel.close({ tabId: 1 })).rejects.toMatchObject({
        code: 'UNSUPPORTED_OPERATION',
      })
      expect(f.calls).toEqual([])
      await panel.close({ windowId: 2 })
    }
  )
  test.each(['145', '156'])(
    'Chrome %s permits strict native tab close',
    async (version) => {
      const f = fixture('chrome', version)
      expect(panel.getCapabilities().close.tab).toBe(true)
      await panel.close({ tabId: 1 })
      expect(f.calls).toEqual([['close', [{ tabId: 1 }]]])
    }
  )
  test('HeadlessChrome exposes the same 145+ strict tab-close capability', async () => {
    const f = fixture()
    global('navigator', { userAgent: 'Mozilla/5.0 HeadlessChrome/145.0.0.0' })
    expect(panel.getCapabilities().close.tab).toBe(true)
    await panel.close({ tabId: 1 })
    expect(f.calls).toEqual([['close', [{ tabId: 1 }]]])
  })
  test('Firefox active-window open/close start before any await and use zero arguments', async () => {
    const f = fixture('firefox')
    const pending = panel.open()
    expect(f.calls).toEqual([['open', []]])
    await pending
    expect(await panel.getState({ windowId: 9 })).toEqual({
      state: 'open',
      source: 'native',
    })
    await panel.close()
    expect(await panel.getState({ windowId: 9 })).toEqual({
      state: 'closed',
      source: 'native',
    })
  })
  test('Firefox rejects every explicit open/close target before native calls', async () => {
    const f = fixture('firefox')
    for (const target of [{ tabId: 1 }, { windowId: 9 }]) {
      await expect(panel.open(target)).rejects.toMatchObject({
        code: 'UNSUPPORTED_OPERATION',
      })
      await expect(panel.close(target)).rejects.toMatchObject({
        code: 'UNSUPPORTED_OPERATION',
      })
    }
    expect(f.calls).toEqual([])
    expect(panel.getCapabilities()).toMatchObject({
      open: { activeWindow: true, tab: false, window: false },
      nativeState: true,
      events: { opened: false, closed: false },
    })
  })
  test('Chrome state stays unknown after events, opens and closes', async () => {
    const f = fixture()
    const expected = {
      state: 'unknown',
      reason: 'NATIVE_STATE_UNAVAILABLE',
    } as const
    const stop = panel.onOpened(() => {})
    await panel.open({ windowId: 9 })
    f.onOpened.emit({ windowId: 9, path: 'panel.html' })
    expect(await panel.getState({ windowId: 9 })).toEqual(expected)
    await panel.close({ windowId: 9 })
    stop()
    expect(await panel.getState({ windowId: 9 })).toEqual(expected)
    expect(f.calls.some(([name]) => name === 'getOptions')).toBe(false)
  })
  test('runtime validation rejects ambiguous, empty, negative, fractional and extra targets', async () => {
    const f = fixture()
    for (const target of [
      {},
      null,
      { tabId: 1, windowId: 2 },
      { tabId: -1 },
      { windowId: NaN },
      { tabId: 1.5 },
      { windowId: 1, extra: true },
      { tabId: undefined },
    ]) {
      await expect(panel.open(target as never)).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      })
      await expect(
        panel.setPage('panel.html', target as never)
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    }
    await expect(panel.getState({ tabId: 1 } as never)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    expect(f.calls).toEqual([])
  })
  test('browser namespace alone is not Firefox evidence; partial polyfills bind chrome methods', async () => {
    const f = fixture()
    global('browser', {
      runtime: f.runtime,
      sidePanel: { getOptions: async () => ({ path: 'polyfill.html' }) },
    })
    expect(panel.getCapabilities().open.tab).toBe(true)
    await panel.open({ tabId: 1 })
    expect(await panel.getPage()).toBe(f.root + 'polyfill.html')
    expect(f.calls).toEqual([['open', [{ tabId: 1 }]]])
  })
})

describe('sidePanel configuration, events and failures', () => {
  test.each(['chrome', 'firefox'] as const)(
    '%s global/tab pages normalize URL and inherit defaults',
    async (kind) => {
      const f = fixture(kind)
      expect(await panel.getPage()).toBeUndefined()
      await panel.setPage('/dir/../panel.html?mode=a#route')
      expect(await panel.getPage({ tabId: 1 })).toBe(
        f.root + 'panel.html?mode=a#route'
      )
      await panel.setPage(f.root + 'tab.html', { tabId: 1 })
      expect(await panel.getPage({ tabId: 1 })).toBe(f.root + 'tab.html')
      expect(await panel.getPage()).toBe(f.root + 'panel.html?mode=a#route')
      expect(
        f.calls
          .filter(([name]) => name.startsWith('set'))
          .every(([, args]) => !('enabled' in (args[0] as object)))
      ).toBe(true)
    }
  )
  test('Firefox window scope is native; Chrome rejects before settings change', async () => {
    let f = fixture('firefox')
    await panel.setPage('window.html', { windowId: 9 })
    expect(await panel.getPage({ windowId: 9 })).toBe(f.root + 'window.html')
    f = fixture()
    await expect(
      panel.setPage('window.html', { windowId: 9 })
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' })
    await expect(panel.getPage({ windowId: 9 })).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
    })
    expect(f.calls).toEqual([])
  })
  test('external, foreign-extension, opaque, empty and malformed pages are rejected before mutation', async () => {
    const f = fixture()
    for (const path of [
      'https://example.com/panel.html',
      'chrome-extension://other/panel.html',
      '//other/panel.html',
      'data:text/html,x',
      'javascript:alert(1)',
      '',
      '  ',
      'http://[',
    ]) {
      await expect(panel.setPage(path)).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      })
    }
    expect(f.calls).toEqual([])
  })
  test('external native configuration is unsupported, not unset; disabled does not mean closed', async () => {
    const f = fixture('firefox')
    f.pages.set('{}', 'https://example.com/panel.html')
    await expect(panel.getPage()).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
    })
    const c = fixture()
    c.chromePanel.getOptions = async () => ({
      path: 'panel.html',
      enabled: false,
    })
    expect(await panel.getPage()).toBe(c.root + 'panel.html')
    expect((await panel.getState({ windowId: 1 })).state).toBe('unknown')
  })
  test('opened/closed normalize native event data and unsubscribe idempotently', () => {
    const f = fixture()
    const events: unknown[] = []
    const stop = panel.onOpened((event) => events.push(event))
    const stopClosed = panel.onClosed((event) => events.push(event))
    f.onOpened.emit({ windowId: 9, tabId: 2, path: 'panel.html?a#b' })
    f.onClosed.emit({ windowId: 9, path: 'panel.html' })
    expect(events).toEqual([
      {
        windowId: 9,
        tabId: 2,
        page: f.root + 'panel.html?a#b',
        source: 'native',
      },
      { windowId: 9, page: f.root + 'panel.html', source: 'native' },
    ])
    f.onOpened.emit({ windowId: -1, path: 'panel.html' })
    f.onOpened.emit({ windowId: 9, path: 'https://example.com' })
    expect(events).toHaveLength(2)
    stop()
    stop()
    stopClosed()
    stopClosed()
    expect(f.onOpened.callbacks.size + f.onClosed.callbacks.size).toBe(0)
    f.onOpened.emit({ windowId: 9, path: 'panel.html' })
    expect(events).toHaveLength(2)
  })
  test('Firefox unsupported events and missing native close are explicit', async () => {
    fixture('firefox')
    expect(() => panel.onOpened(() => {})).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_OPERATION' })
    )
    expect(() => panel.onClosed(() => {})).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_OPERATION' })
    )
    const f = fixture()
    Reflect.deleteProperty(f.chromePanel, 'close')
    expect(panel.getCapabilities().close.window).toBe(false)
    await expect(panel.close({ windowId: 1 })).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
    })
    expect(f.calls).toEqual([])
  })
  test.each([
    [
      'This may only be called in response to a user gesture.',
      'USER_GESTURE_REQUIRED',
    ],
    [
      'sidebarAction.open may only be called from a user input handler',
      'USER_GESTURE_REQUIRED',
    ],
    ['Missing sidePanel permission', 'PERMISSION_DENIED'],
    ['No tab with id: 5', 'TAB_NOT_FOUND'],
    ['Invalid window ID: 5', 'WINDOW_NOT_FOUND'],
    ['unexpected native failure', 'NATIVE_ERROR'],
  ])('preserves cause and classifies %s narrowly', async (message, code) => {
    const f = fixture()
    const cause = new Error(message)
    f.chromePanel.open = () => {
      throw cause
    }
    await expect(panel.open({ windowId: 1 })).rejects.toMatchObject({
      code,
      cause,
      operation: 'sidePanel.open',
    })
  })
  test('native query failures are not turned into unknown/unset', async () => {
    const f = fixture('firefox')
    const cause = new Error('Permission denied')
    f.sidebar.getPanel = async () => {
      throw cause
    }
    f.sidebar.isOpen = async () => {
      throw cause
    }
    await expect(panel.getPage()).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      cause,
    })
    await expect(panel.getState({ windowId: 1 })).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      cause,
    })
  })
})
