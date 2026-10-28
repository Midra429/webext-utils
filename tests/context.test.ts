import { afterEach, describe, expect, test } from 'bun:test'

import { WebextError, isWebextError, webextContext } from '../src/context'
import { POPOUT_KEY_PREFIX, POPOUT_PARAM } from '../src/internal/popout-record'

const root = 'chrome-extension://test-extension/'
const restores: (() => void)[] = []
const stops: (() => void)[] = []

function global(name: string, value: unknown): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  })
  restores.push(() => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  })
}

function page(href = `${root}shared.html`) {
  const events = new Map<string, ((event: { persisted?: boolean }) => void)[]>()
  const window: {
    top?: unknown
    addEventListener: (
      name: string,
      cb: (event: { persisted?: boolean }) => void
    ) => void
  } = {
    addEventListener(name, cb) {
      events.set(name, [...(events.get(name) ?? []), cb])
    },
  }
  window.top = window
  global('window', window)
  global('document', {})
  global('location', { href })
  const runtime = {
    id: 'test-extension',
    getURL(path: string) {
      expect(this).toBe(runtime)
      return `${root}${path}`
    },
    getManifest() {
      return { manifest_version: 3 }
    },
    getContexts: async (_filter: unknown): Promise<unknown[]> => [],
  }
  const api = {
    runtime,
    extension: {
      getViews: (_filter: { type: string }): unknown[] => [],
      getBackgroundPage: (): unknown => undefined,
    },
    tabs: { getCurrent: async (): Promise<unknown> => undefined },
    windows: { getCurrent: async (): Promise<unknown> => ({ id: 5 }) },
    storage: {
      session: { get: async (_key: string): Promise<unknown> => ({}) },
    },
  }
  global('browser', undefined)
  global('chrome', api)
  return {
    api,
    window,
    events,
    emit(name: string, event: { persisted?: boolean } = {}) {
      for (const cb of events.get(name) ?? []) cb(event)
    },
  }
}

function context(type: string, extra: Record<string, unknown> = {}) {
  return {
    contextType: type,
    contextId: 'instance',
    documentId: 'document',
    documentUrl: `${root}shared.html`,
    tabId: -1,
    windowId: 5,
    frameId: 0,
    ...extra,
  }
}

function register(role: Parameters<typeof webextContext.register>[0]) {
  const stop = webextContext.register(role)
  stops.push(stop)
  return stop
}

afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  for (const restore of restores.splice(0).reverse()) restore()
})

describe('synchronous native evidence', () => {
  test('SSR imports/get are safe and resolve fails explicitly', async () => {
    expect(webextContext.get()).toEqual({ kind: 'unknown', source: 'unknown' })
    await expect(webextContext.resolve()).rejects.toMatchObject({
      code: 'CONTEXT_UNAVAILABLE',
    })
  })
  test('ordinary MAIN page remains unknown until explicitly registered', async () => {
    page('https://example.com/')
    global('chrome', { runtime: { sendMessage() {} } })
    expect(webextContext.get().kind).toBe('unknown')
    const stop = register({ kind: 'content-script', world: 'MAIN' })
    expect(await webextContext.resolve()).toMatchObject({
      kind: 'content-script',
      world: 'MAIN',
      source: 'registered',
    })
    stop()
    stop()
    expect(webextContext.get().kind).toBe('unknown')
  })
  test('ISOLATED requires runtime identity and a document on a foreign origin', () => {
    page('https://example.com/')
    expect(webextContext.get()).toEqual({
      kind: 'content-script',
      world: 'ISOLATED',
      source: 'native',
    })
  })
  test('extension protocol alone is insufficient', () => {
    page()
    global('chrome', undefined)
    expect(webextContext.get().kind).toBe('unknown')
  })
  test('an extension URL in an ordinary worker is not a background SW', () => {
    page()
    global('document', undefined)
    global('window', undefined)
    expect(webextContext.get().kind).toBe('unknown')
  })
  test('a real service-worker global is recognized without a window', async () => {
    const { api } = page()
    global('document', undefined)
    global('window', undefined)
    class WorkerScope {
      static [Symbol.hasInstance](value: unknown) {
        return value === globalThis
      }
    }
    global('ServiceWorkerGlobalScope', WorkerScope)
    api.runtime.getContexts = async () => [
      context('BACKGROUND', {
        documentUrl: undefined,
        tabId: -1,
        windowId: -1,
        frameId: -1,
      }),
    ]
    expect(await webextContext.resolve()).toEqual({
      kind: 'background',
      implementation: 'service-worker',
      source: 'native',
      instanceId: 'instance',
      documentId: 'document',
    })
  })
  test('Firefox background requires self Window identity', () => {
    const { api, window } = page()
    api.extension.getBackgroundPage = () => window
    expect(webextContext.get()).toMatchObject({
      kind: 'background',
      implementation: 'page',
    })
  })
  test('popup is selected by self Window rather than a manifest path', () => {
    const { api, window } = page()
    api.extension.getViews = ({ type }) => (type === 'popup' ? [window] : [])
    expect(webextContext.get()).toEqual({ kind: 'popup', source: 'native' })
  })
  test('another popup with the same HTML is not self', () => {
    const { api } = page()
    api.extension.getViews = () => [{}]
    expect(webextContext.get().kind).toBe('unknown')
  })
  test('Firefox sidebar is normalized without treating browser as Firefox', () => {
    const { api, window } = page('moz-extension://test-extension/shared.html')
    api.runtime.getURL = (path) => `moz-extension://test-extension/${path}`
    api.extension.getViews = ({ type }) => (type === 'sidebar' ? [window] : [])
    global('browser', { ...api, sidebarAction: { open() {} } })
    expect(webextContext.get().kind).toBe('side-panel')
  })
  test('Chrome is never passed the Firefox-only sidebar view enum', () => {
    const { api } = page()
    api.extension.getViews = ({ type }) => {
      expect(type).not.toBe('sidebar')
      return []
    }
    webextContext.get()
  })
  test('DevTools evidence is normalized', () => {
    const { api } = page()
    global('chrome', { ...api, devtools: { inspectedWindow: { tabId: 12 } } })
    expect(webextContext.get().kind).toBe('devtools')
    expect(webextContext.get().tabId).toBeUndefined()
  })
})

describe('resolve identity and cache', () => {
  test('a unique panel in the current window can be resolved', async () => {
    const { api } = page()
    api.runtime.getContexts = async () => [
      context('SIDE_PANEL'),
      context('SIDE_PANEL', { windowId: 6 }),
    ]
    expect(await webextContext.resolve()).toMatchObject({
      kind: 'side-panel',
      instanceId: 'instance',
      windowId: 5,
    })
    expect(webextContext.get().kind).toBe('side-panel')
  })
  test('same URL with multiple views is left unknown', async () => {
    const { api } = page()
    api.runtime.getContexts = async () => [
      context('POPUP'),
      context('SIDE_PANEL'),
    ]
    expect((await webextContext.resolve()).kind).toBe('unknown')
  })
  test('tab identity disambiguates same URL across tabs and frames', async () => {
    const { api } = page()
    api.tabs.getCurrent = async () => ({ id: 7, windowId: 5 })
    api.runtime.getContexts = async () => [
      context('TAB', { tabId: 7 }),
      context('TAB', { tabId: 8 }),
      context('TAB', { tabId: 7, frameId: 2 }),
    ]
    expect(await webextContext.resolve()).toMatchObject({
      kind: 'extension-page',
      tabId: 7,
      frameId: 0,
    })
  })
  test('manifest options path does not override a normal tab', async () => {
    const { api, window } = page()
    api.runtime.getManifest = () => ({
      manifest_version: 3,
      options_ui: { page: 'shared.html' },
    })
    api.extension.getViews = ({ type }) => (type === 'tab' ? [window] : [])
    expect(webextContext.get().kind).toBe('extension-page')
    register({ kind: 'options' })
    expect((await webextContext.resolve()).kind).toBe('options')
  })
  test('an embedded same-URL document cannot borrow the top frame identity', async () => {
    const { api, window } = page()
    window.top = {}
    api.tabs.getCurrent = async () => ({ id: 7, windowId: 5 })
    api.runtime.getContexts = async () => [context('TAB', { tabId: 7 })]
    const info = await webextContext.resolve()
    expect(info.kind).toBe('unknown')
    expect(info.documentId).toBeUndefined()
  })
  test('no window identity means getContexts URL matches are insufficient', async () => {
    const { api } = page()
    api.windows.getCurrent = async () => undefined
    api.runtime.getContexts = async () => [context('POPUP')]
    expect((await webextContext.resolve()).kind).toBe('unknown')
  })
  test('per-method browser/chrome fallback preserves receivers', async () => {
    const { api } = page()
    global('browser', { runtime: { id: 'test-extension' } })
    api.runtime.getContexts = async function () {
      expect(this).toBe(api.runtime)
      return [context('SIDE_PANEL')]
    }
    expect((await webextContext.resolve()).kind).toBe('side-panel')
  })
  test('native errors retain the cause and are not hidden as unknown', async () => {
    const { api } = page()
    const cause = new Error('denied')
    api.runtime.getContexts = async () => {
      throw cause
    }
    await expect(webextContext.resolve()).rejects.toMatchObject({
      code: 'NATIVE_ERROR',
      cause,
    })
  })
  test('missing optional APIs do not prevent synchronous evidence', async () => {
    const { api, window } = page()
    api.extension.getViews = ({ type }) => (type === 'popup' ? [window] : [])
    global('chrome', {
      runtime: {
        id: api.runtime.id,
        getURL: api.runtime.getURL.bind(api.runtime),
        getManifest: api.runtime.getManifest,
      },
      extension: api.extension,
    })
    expect((await webextContext.resolve()).kind).toBe('popup')
  })
  test('BFCache restoration invalidates prior document metadata', async () => {
    const { api, emit } = page()
    api.runtime.getContexts = async () => [context('SIDE_PANEL')]
    await webextContext.resolve()
    emit('pagehide')
    expect(webextContext.get().kind).toBe('unknown')
    api.runtime.getContexts = async () => [context('POPUP')]
    expect((await webextContext.resolve()).kind).toBe('popup')
  })
  test('initial pageshow keeps cache and persisted pageshow invalidates it', async () => {
    const { api, emit } = page()
    api.runtime.getContexts = async () => [context('SIDE_PANEL')]
    await webextContext.resolve()
    emit('pageshow', { persisted: false })
    expect(webextContext.get().kind).toBe('side-panel')
    emit('pageshow', { persisted: true })
    expect(webextContext.get().kind).toBe('unknown')
  })
  test('repeated resolve does not duplicate lifecycle listeners', async () => {
    const { events } = page()
    await webextContext.resolve()
    await webextContext.resolve()
    expect(events.get('pagehide')).toHaveLength(1)
    expect(events.get('pageshow')).toHaveLength(1)
  })
  test('in-flight resolve cannot restore cache after BFCache departure', async () => {
    const { api, emit } = page()
    let release!: (value: unknown[]) => void
    api.runtime.getContexts = () =>
      new Promise((resolve) => {
        release = resolve
      })
    const pending = webextContext.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    emit('pagehide')
    release([context('SIDE_PANEL')])
    await expect(pending).rejects.toMatchObject({ code: 'CONTEXT_UNAVAILABLE' })
    expect(webextContext.get().kind).toBe('unknown')
  })
  test('navigation invalidates cached identity and returned objects are frozen', async () => {
    const { api } = page()
    api.runtime.getContexts = async () => [context('SIDE_PANEL')]
    const result = await webextContext.resolve()
    expect(Object.isFrozen(result)).toBe(true)
    global('location', { href: `${root}other.html` })
    expect(webextContext.get().kind).toBe('unknown')
  })
})

describe('registration contracts', () => {
  test('same-role registrations have independent idempotent cleanup', () => {
    page()
    const a = register({ kind: 'options' })
    register({ kind: 'options' })
    a()
    a()
    expect(webextContext.get().kind).toBe('options')
  })
  test('native popup evidence rejects contradictory registration', () => {
    const { api, window } = page()
    api.extension.getViews = ({ type }) => (type === 'popup' ? [window] : [])
    expect(() => register({ kind: 'side-panel' })).toThrow(WebextError)
    expect(webextContext.get().kind).toBe('popup')
  })
  test('MAIN cannot override native ISOLATED evidence', () => {
    page('https://example.com/')
    expect(() => register({ kind: 'content-script', world: 'MAIN' })).toThrow(
      WebextError
    )
  })
  test('different roles conflict and plain pages cannot declare popup', () => {
    page()
    register({ kind: 'options' })
    expect(() => register({ kind: 'popup' })).toThrow(WebextError)
  })
  test('runtime callers cannot inject IDs or declare popout', () => {
    page()
    const unsafe: unknown = { kind: 'popup', tabId: 9 }
    expect(() =>
      webextContext.register(unsafe as Parameters<typeof register>[0])
    ).toThrow(WebextError)
    expect(() =>
      webextContext.register({ kind: 'popout' } as unknown as Parameters<
        typeof register
      >[0])
    ).toThrow(WebextError)
  })
  test('SSR registration is rejected and ordinary pages cannot claim privileged roles', () => {
    expect(() => register({ kind: 'options' })).toThrow(WebextError)
    page('https://example.com/')
    global('chrome', undefined)
    expect(() => register({ kind: 'popup' })).toThrow(WebextError)
  })
  test('later native evidence validates an earlier declaration', async () => {
    const { api } = page()
    register({ kind: 'options' })
    api.runtime.getContexts = async () => [context('POPUP')]
    await expect(webextContext.resolve()).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
  })
})

describe('verified popout records', () => {
  const token = 'abcdefghijklmnop1234'
  function popout(overrides: Record<string, unknown> = {}) {
    const href = `${root}shared.html?${POPOUT_PARAM}=${token}#route`
    const p = page(href)
    p.api.tabs.getCurrent = async () => ({ id: 10, windowId: 5 })
    const record = {
      version: 1,
      status: 'ready',
      token,
      tabId: 10,
      windowId: 5,
      source: 'popup',
      page: `${root}shared.html#route`,
      associatedTabId: 42,
      ...overrides,
    }
    p.api.storage.session.get = async (key) => ({ [key]: record })
    return { ...p, record }
  }
  test('marker stays unknown synchronously, then verified record takes priority', async () => {
    const { api, window } = popout()
    api.extension.getViews = () => [window]
    expect(webextContext.get().kind).toBe('unknown')
    expect(await webextContext.resolve()).toMatchObject({
      kind: 'popout',
      origin: 'popup',
      source: 'verified-record',
      tabId: 10,
      windowId: 5,
      associatedTabId: 42,
      instanceId: token,
    })
    expect(webextContext.get().kind).toBe('popout')
  })
  test.each([
    { tabId: 11 },
    { windowId: 6 },
    { token: 'copied-token' },
    { version: 2 },
    { status: 'expired' },
    { page: `${root}other.html` },
    { source: 'other' },
    { associatedTabId: -1 },
  ])('rejects copied, stale or invalid record %j', async (overrides) => {
    popout(overrides)
    expect((await webextContext.resolve()).kind).toBe('unknown')
  })
  test('an unavailable record does not fall back to native popup', async () => {
    const { api } = popout()
    api.storage.session.get = async () => ({})
    api.runtime.getContexts = async () => [
      context('POPUP', {
        tabId: 10,
        documentUrl: `${root}shared.html?${POPOUT_PARAM}=${token}#route`,
      }),
    ]
    expect((await webextContext.resolve()).kind).toBe('unknown')
  })
  test('a copied marker inside an iframe cannot acquire the parent popout identity', async () => {
    const { window } = popout()
    window.top = {}
    expect((await webextContext.resolve()).kind).toBe('unknown')
  })
  test('registration cannot bypass a pending popout marker', () => {
    popout()
    expect(() => register({ kind: 'popup' })).toThrow(WebextError)
    expect(webextContext.get().kind).toBe('unknown')
  })
  test('duplicate and malformed tokens do not access storage', async () => {
    const { api } = popout()
    api.storage.session.get = async () => {
      throw new Error('must not read')
    }
    global('location', { href: `${root}shared.html?${POPOUT_PARAM}=short` })
    expect((await webextContext.resolve()).kind).toBe('unknown')
    global('location', {
      href: `${root}shared.html?${POPOUT_PARAM}=${token}&${POPOUT_PARAM}=${token}`,
    })
    expect((await webextContext.resolve()).kind).toBe('unknown')
  })
  test('pending record waits briefly for ready', async () => {
    const { api, record } = popout()
    let reads = 0
    api.storage.session.get = async (key) => ({
      [key]: { ...record, status: ++reads < 2 ? 'pending' : 'ready' },
    })
    expect((await webextContext.resolve()).kind).toBe('popout')
    expect(reads).toBe(2)
  })
  test('pending record is never considered verified', async () => {
    popout({ status: 'pending' })
    expect((await webextContext.resolve()).kind).toBe('unknown')
  })
  test('session failures retain their native cause', async () => {
    const { api } = popout()
    api.storage.session.get = async (key) => {
      expect(key).toBe(`${POPOUT_KEY_PREFIX}${token}`)
      throw new Error('quota')
    }
    await expect(webextContext.resolve()).rejects.toMatchObject({
      code: 'NATIVE_ERROR',
    })
  })
})

test('error guard narrows the shared error type', () => {
  const error: unknown = new WebextError('INVALID_ARGUMENT', 'test', 'bad')
  expect(isWebextError(error)).toBe(true)
  expect(isWebextError({ code: 'INVALID_ARGUMENT' })).toBe(false)
})
