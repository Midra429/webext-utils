import { afterEach, describe, expect, test } from 'bun:test'

import { webextSidePanel as panel } from '../src/side-panel'

type Kind = 'chrome' | 'firefox'
type Listener = (...args: unknown[]) => unknown

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

function event() {
  const listeners = new Set<Listener>()
  return {
    listeners,
    api: {
      addListener: (listener: Listener) => listeners.add(listener),
      removeListener: (listener: Listener) => listeners.delete(listener),
    },
    emit: (...args: unknown[]) => {
      for (const listener of [...listeners]) listener(...args)
    },
  }
}

/** A small browser model shared by both native APIs. */
function fixture(kind: Kind, options: { focused?: number } = {}) {
  const root =
    kind === 'chrome' ? 'chrome-extension://self/' : 'moz-extension://self/'
  const focused = options.focused ?? 9
  const open = new Set<number>()
  const calls: string[] = []
  let page = ''
  const manifest =
    kind === 'chrome'
      ? { side_panel: { default_path: 'panel.html' } }
      : { sidebar_action: { default_panel: 'panel.html' } }
  const onMessage = event()
  const onClicked = event()
  const nativeOpened = event()
  const nativeClosed = event()
  const sent: unknown[] = []
  const window = new EventTarget()
  const runtime = {
    id: 'self',
    getURL: (path: string) => root + path,
    getManifest: () => manifest,
    sendMessage: async (message: unknown) => {
      sent.push(message)
    },
    onMessage: onMessage.api,
    getContexts: async (filter: { windowIds?: number[] }) => {
      calls.push(`getContexts:${JSON.stringify(filter)}`)
      return [...open]
        .filter((id) => !filter.windowIds || filter.windowIds.includes(id))
        .map((windowId) => ({ contextType: 'SIDE_PANEL', windowId }))
    },
  }
  const windows = {
    getLastFocused: async () => {
      calls.push('getLastFocused')
      return { id: focused }
    },
    getCurrent: async () => ({ id: focused }),
    onRemoved: event().api,
  }
  const chromePanel = {
    open: async ({ windowId }: { windowId: number }) => {
      calls.push(`open:${windowId}`)
      if (!open.has(windowId)) {
        open.add(windowId)
        nativeOpened.emit({ windowId, path: page })
      }
    },
    close: async ({ windowId }: { windowId: number }) => {
      calls.push(`close:${windowId}`)
      if (open.delete(windowId)) nativeClosed.emit({ windowId, path: page })
    },
    setOptions: async (value: { path: string; enabled: boolean }) => {
      calls.push(`setOptions:${JSON.stringify(value)}`)
      page = value.path
    },
    getOptions: async () => ({ path: page || 'panel.html', enabled: true }),
    onOpened: nativeOpened.api,
    onClosed: nativeClosed.api,
  }
  const sidebar = {
    open: async () => {
      calls.push(`open:${focused}`)
      open.add(focused)
    },
    close: async () => {
      calls.push(`close:${focused}`)
      open.delete(focused)
    },
    toggle: async () => {
      calls.push(`toggle:${focused}`)
      if (!open.delete(focused)) open.add(focused)
    },
    isOpen: async ({ windowId }: { windowId: number }) => open.has(windowId),
    setPanel: async ({ panel }: { panel: string | null }) => {
      calls.push(`setPanel:${panel}`)
      page = panel ?? ''
    },
    getPanel: async () => page || `${root}panel.html`,
  }
  const api = {
    runtime,
    windows,
    action: { onClicked: onClicked.api },
    extension: { getBackgroundPage: () => undefined as unknown },
    ...(kind === 'chrome'
      ? { sidePanel: chromePanel }
      : { sidebarAction: sidebar }),
  }
  global(kind === 'chrome' ? 'chrome' : 'browser', api)
  global(kind === 'chrome' ? 'browser' : 'chrome', undefined)
  return {
    root,
    api,
    open,
    calls,
    sent,
    window,
    onMessage,
    onClicked,
    /** Turns this realm into the extension page at `path`. */
    page(path: string) {
      global('location', { href: root + path })
      global('document', {})
      global('window', window)
    },
    /** Turns this realm into the Background page. */
    background() {
      this.page('background.html')
      api.extension.getBackgroundPage = () => window
    },
  }
}

const kinds: Kind[] = ['chrome', 'firefox']

describe.each(kinds)('%s', (kind) => {
  test('open / close / toggle / isOpen behave the same', async () => {
    const f = fixture(kind)
    expect(await panel.isOpen()).toBe(false)
    await panel.open()
    expect(await panel.isOpen()).toBe(true)
    expect(await panel.isOpen({ windowId: 9 })).toBe(true)
    expect(await panel.isOpen({ windowId: 1 })).toBe(false)
    await panel.open() // no-op when already open
    await panel.toggle()
    expect(await panel.isOpen()).toBe(false)
    await panel.toggle()
    expect(f.open).toEqual(new Set([9]))
    await panel.close()
    await panel.close() // no-op when already closed
    expect(f.open.size).toBe(0)
  })

  test('the native open call starts before any await when windowId is known', () => {
    const f = fixture(kind)
    void panel.open({ windowId: 9 })
    expect(f.calls).toEqual(['open:9'])
  })

  test('pages are normalized to absolute URLs of this extension', async () => {
    const f = fixture(kind)
    expect(await panel.getPage()).toBe(`${f.root}panel.html`)
    await panel.setPage('views/panel.html?mode=a#top')
    expect(await panel.getPage()).toBe(`${f.root}views/panel.html?mode=a#top`)
    await panel.setPage(`${f.root}other.html`)
    expect(await panel.getPage()).toBe(`${f.root}other.html`)
    await panel.resetPage()
    expect(await panel.getPage()).toBe(`${f.root}panel.html`)
  })

  test('foreign pages and invalid options are rejected before side effects', async () => {
    const f = fixture(kind)
    for (const path of [
      'https://example.com/',
      'chrome-extension://other/panel.html',
      'moz-extension://other/panel.html',
      '',
      '   ',
    ])
      await expect(panel.setPage(path)).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      })
    for (const options of [
      { windowId: -1 },
      { windowId: 1.5 },
      { tabId: 1 },
      null,
    ])
      await expect(
        panel.open(options as { windowId: number })
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(f.calls).toEqual([])
  })

  test('native failures are classified', async () => {
    const f = fixture(kind)
    const api = f.api as unknown as Record<string, Record<string, unknown>>
    const target = api[kind === 'chrome' ? 'sidePanel' : 'sidebarAction']!
    target.open = async () => {
      throw new Error(
        'sidePanel.open() may only be called in response to a user gesture.'
      )
    }
    await expect(panel.open({ windowId: 9 })).rejects.toMatchObject({
      code: 'USER_GESTURE_REQUIRED',
      operation: 'sidePanel.open',
    })
  })

  test('registerPanel announces opened and closed to every listener', async () => {
    const f = fixture(kind)
    f.page('panel.html')
    const events: string[] = []
    const stopOpened = panel.onOpened((e) =>
      events.push(`opened:${e.windowId}:${e.page}`)
    )
    const stopClosed = panel.onClosed((e) =>
      events.push(`closed:${e.windowId}:${e.page}`)
    )
    const registration = panel.registerPanel()
    expect(() => panel.registerPanel()).toThrow()
    await registration.ready
    f.window.dispatchEvent(new Event('pagehide'))
    const page = `${f.root}panel.html`
    expect(events).toEqual([`opened:9:${page}`, `closed:9:${page}`])
    expect(f.sent).toEqual([
      {
        protocol: '@midra/webext-utils/side-panel',
        version: 1,
        type: 'opened',
        windowId: 9,
        page,
      },
      {
        protocol: '@midra/webext-utils/side-panel',
        version: 1,
        type: 'closed',
        windowId: 9,
        page,
      },
    ])
    // The registration was released by pagehide.
    panel.registerPanel()()
    stopOpened()
    stopClosed()
    expect(f.onMessage.listeners.size).toBe(0)
  })

  test('listeners receive events from other extension pages only', () => {
    const f = fixture(kind)
    const events: unknown[] = []
    const stop = panel.onOpened((e) => events.push(e))
    const message = {
      protocol: '@midra/webext-utils/side-panel',
      version: 1,
      type: 'opened',
      windowId: 3,
      page: 'panel.html',
    }
    f.onMessage.emit(message, { id: 'self', url: `${f.root}panel.html` })
    f.onMessage.emit(message, { id: 'other', url: `${f.root}panel.html` })
    f.onMessage.emit(message, {
      id: 'self',
      url: 'https://example.com/',
      tab: { id: 1 },
    })
    f.onMessage.emit(
      { ...message, windowId: -1 },
      { id: 'self', url: `${f.root}x.html` }
    )
    f.onMessage.emit(
      { ...message, page: 'https://example.com/' },
      {
        id: 'self',
        url: `${f.root}x.html`,
      }
    )
    expect(events).toEqual([{ windowId: 3, page: `${f.root}panel.html` }])
    stop()
    stop()
  })

  test('startBackground toggles on action click inside the gesture', async () => {
    const f = fixture(kind)
    f.background()
    expect(() =>
      panel.startBackground({ openOnActionClick: 'yes' } as never)
    ).toThrow()
    const stop = panel.startBackground({ openOnActionClick: true })
    expect(() => panel.startBackground()).toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))
    f.calls.length = 0
    f.onClicked.emit({ id: 1, windowId: 9 })
    // The native call happens synchronously in the click handler.
    expect(f.calls).toEqual(kind === 'chrome' ? ['open:9'] : ['toggle:9'])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(await panel.isOpen({ windowId: 9 })).toBe(true)
    f.onClicked.emit({ id: 1, windowId: 9 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(await panel.isOpen({ windowId: 9 })).toBe(false)
    stop()
    stop()
    expect(f.onClicked.listeners.size).toBe(0)
  })

  test('startBackground is rejected outside the Background', () => {
    const f = fixture(kind)
    f.page('popup.html')
    expect(() => panel.startBackground()).toThrow(
      expect.objectContaining({ code: 'CONTEXT_UNAVAILABLE' })
    )
  })
})

describe('without a browser', () => {
  test('every operation reports CONTEXT_UNAVAILABLE', async () => {
    global('chrome', undefined)
    global('browser', undefined)
    for (const operation of [
      panel.open,
      panel.close,
      panel.toggle,
      panel.isOpen,
      panel.getPage,
      panel.resetPage,
    ])
      await expect(operation()).rejects.toMatchObject({
        code: 'CONTEXT_UNAVAILABLE',
      })
    expect(() => panel.onOpened(() => {})).toThrow()
    expect(() => panel.registerPanel()).toThrow()
  })

  test('a missing side panel API is UNSUPPORTED_OPERATION', async () => {
    global('chrome', {
      runtime: {
        id: 'self',
        getURL: (p: string) => `chrome-extension://self/${p}`,
      },
    })
    global('browser', undefined)
    await expect(panel.open()).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
    })
  })
})
