import type { Request } from '../src/messaging/protocol'
import type { MessageSender } from '../src/messaging/types'

import { afterEach, describe, expect, test } from 'bun:test'

import { webextContext } from '../src/context'
import {
  POPOUT_PARAM as PARAM,
  POPOUT_KEY_PREFIX as PREFIX,
} from '../src/internal/popout-record'
import { success } from '../src/messaging/protocol'
import { currentRealm } from '../src/messaging/shared'
import { webextPopout as popout } from '../src/popout'
import { PopoutManager } from '../src/popout/manager'

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
function fixture(firefox = false) {
  const base = firefox ? 'moz-extension://self/' : 'chrome-extension://self/'
  const win = { top: undefined as unknown }
  win.top = win
  const data: Record<string, unknown> = {}
  const windows = new Map<number, Record<string, unknown>>()
  const tabs = new Map<number, Record<string, unknown>>()
  const calls: { path: string; args: unknown[] }[] = []
  let serial = 10
  let tail: Promise<unknown> = Promise.resolve()
  const locks = {
    request(_name: string, work: () => Promise<unknown>) {
      const task = tail.then(work)
      tail = task.catch(() => {})
      return task
    },
  }
  const event = () => {
    const callbacks = new Set<(...args: unknown[]) => void>()
    return {
      callbacks,
      addListener: (cb: (...args: unknown[]) => void) => {
        callbacks.add(cb)
      },
      removeListener: (cb: (...args: unknown[]) => void) => {
        callbacks.delete(cb)
      },
    }
  }
  const onRemoved = event(),
    onTabRemoved = event(),
    onUpdated = event(),
    onAttached = event()
  const session = {
    async get(name: string | null) {
      return structuredClone(name === null ? data : { [name]: data[name] })
    },
    async set(items: Record<string, unknown>) {
      Object.assign(data, structuredClone(items))
    },
    async remove(name: string) {
      delete data[name]
    },
  }
  const api = {
    runtime: {
      async sendMessage(r: {
        id: string
        data: { operation: string; value: unknown }
      }) {
        const value = await manager.request(r.data.operation, r.data.value)
        return success(r.id, {
          ok: true,
          ...(value === undefined ? {} : { value }),
        })
      },
      id: 'self',
      getURL: (path: string) =>
        base + (path.startsWith('/') ? path.slice(1) : path),
      getManifest: () => ({
        action: { default_popup: 'manifest.html' },
        side_panel: { default_path: 'manifest-panel.html' },
      }),
    },
    extension: { getBackgroundPage: () => win },
    storage: { session },
    action: {
      async getPopup(target: unknown) {
        calls.push({ path: 'getPopup', args: [target] })
        return 'ui.html?name=a%20b#route'
      },
    },
    ...(firefox
      ? {
          sidebarAction: {
            async getPanel(target: unknown) {
              calls.push({ path: 'getPanel', args: [target] })
              return base + 'panel.html'
            },
          },
        }
      : {
          sidePanel: {
            async getOptions(target: unknown) {
              calls.push({ path: 'getOptions', args: [target] })
              return { path: 'panel.html', enabled: true }
            },
          },
        }),
    windows: {
      async getAll() {
        calls.push({ path: 'getAll', args: [] })
        return structuredClone([...windows.values()])
      },
      async create(opts: Record<string, unknown>) {
        calls.push({ path: 'create', args: [opts] })
        const id = serial++,
          tabId = serial++
        const tab = {
          id: tabId,
          windowId: id,
          url: opts.url,
          index: 0,
          active: true,
          pinned: false,
        }
        const window = {
          id,
          type: 'popup',
          ...opts,
          width: (opts.width as number) + 2,
          tabs: [tab],
        }
        windows.set(id, window)
        tabs.set(tabId, tab)
        return structuredClone(window)
      },
      async remove(id: number) {
        calls.push({ path: 'remove', args: [id] })
        if (!windows.delete(id)) throw new Error(`No window with id: ${id}`)
      },
      async update(id: number, value: unknown) {
        calls.push({ path: 'focus', args: [id, value] })
        return windows.get(id)
      },
      onRemoved,
    },
    tabs: {
      async query(value: Record<string, unknown>) {
        calls.push({ path: 'query', args: [value] })
        return value.active
          ? [{ id: 7, windowId: value.windowId }]
          : [...tabs.values()].filter((t) => t.windowId === value.windowId)
      },
      async get(id: number) {
        const tab = tabs.get(id)
        if (!tab) throw new Error(`No tab with id: ${id}`)
        return structuredClone(tab)
      },
      async getCurrent() {
        return [...tabs.values()][0]
      },
      async update(id: number, value: unknown) {
        calls.push({ path: 'activate', args: [id, value] })
      },
      onRemoved: onTabRemoved,
      onUpdated,
      onAttached,
    },
  }
  global('chrome', firefox ? undefined : api)
  global('browser', firefox ? api : undefined)
  global('window', win)
  global('document', {})
  global('location', { href: base + 'background.html' })
  global('navigator', { locks })
  const manager = new PopoutManager()
  return {
    api,
    base,
    win,
    data,
    windows,
    tabs,
    calls,
    manager,
    onRemoved,
    onTabRemoved,
    onUpdated,
    onAttached,
  }
}

describe('popout', () => {
  for (const firefox of [false, true]) {
    test(`${firefox ? 'Firefox' : 'Chrome'} page discovery, default bounds, identity, context and immutable handle`, async () => {
      const f = fixture(firefox)
      const h = await popout.open({ source: 'popup', associatedTabId: 7 })
      expect(h.page).toBe(f.base + 'ui.html?name=a+b#route')
      expect(h.bounds).toMatchObject({ width: 482, height: 720 })
      expect(h.options).toMatchObject({ source: 'popup', associatedTabId: 7 })
      expect(h.messageTarget()).toEqual({
        context: 'content-script',
        tabId: 7,
        frameId: 0,
        world: 'ISOLATED',
      })
      expect(h.messageTarget({ world: 'MAIN', documentId: 'doc' })).toEqual({
        context: 'content-script',
        tabId: 7,
        world: 'MAIN',
        documentId: 'doc',
      })
      expect(Object.isFrozen(h)).toBe(true)
      expect(Object.isFrozen(h.options)).toBe(true)
      const own = [...f.tabs.values()][0]!
      global('location', { href: own.url })
      expect((await webextContext.resolve()).kind).toBe('popout')
      expect((await popout.getCurrent())?.windowId).toBe(h.windowId)
      expect((await popout.get(h.windowId))?.page).toBe(h.page)
      await h.close()
      expect(await popout.get(h.windowId)).toBeUndefined()
      expect(h.originalUiClose.status).toBe('not-requested')
    })
    test(`${firefox ? 'Firefox' : 'Chrome'} source window resolution and side panel discovery`, async () => {
      const f = fixture(firefox)
      const h = await popout.open({
        source: 'sidePanel',
        sourceTarget: { windowId: 2 },
      })
      expect(h.page).toBe(f.base + 'panel.html')
      expect(h.sourceTarget).toEqual(firefox ? { windowId: 2 } : { tabId: 7 })
      expect(h.associatedTabId).toBeUndefined()
      expect(await h.tabExists()).toBe(false)
      await expect(h.getTab()).rejects.toMatchObject({
        code: 'CONTEXT_UNAVAILABLE',
      })
      expect(() => h.messageTarget()).toThrow('no associated tab')
    })
  }
  test('simultaneous reuse is serialized, incompatible key fails and unkeyed opens multiply', async () => {
    const f = fixture()
    const [a, b] = await Promise.all([
      popout.open({ source: 'popup', reuseKey: 'one' }),
      popout.open({ source: 'popup', reuseKey: 'one', width: 900 }),
    ])
    expect(a.windowId).toBe(b.windowId)
    expect(b.bounds.width).toBe(482)
    expect(f.calls.filter((c) => c.path === 'create')).toHaveLength(1)
    await expect(
      popout.open({ source: 'sidePanel', reuseKey: 'one' })
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(
      popout.open({ source: 'popup', reuseKey: 'one', associatedTabId: 7 })
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect((await popout.open({ source: 'popup' })).windowId).not.toBe(
      a.windowId
    )
  })
  test('explicit page wins and sourceTarget remains independent from association', async () => {
    const f = fixture()
    const h = await popout.open({
      source: 'popup',
      page: 'custom.html?a=1#hash',
      sourceTarget: { tabId: 3 },
      associatedTabId: 7,
      width: 500,
      height: 600,
      left: -100,
      top: 25,
      focused: false,
    })
    expect(f.calls.some((c) => c.path === 'getPopup')).toBe(false)
    expect(h.page).toBe(f.base + 'custom.html?a=1#hash')
    expect(h.sourceTarget).toEqual({ tabId: 3 })
    expect(h.associatedTabId).toBe(7)
    expect(f.calls.find((c) => c.path === 'create')?.args[0]).toMatchObject({
      left: -100,
      top: 25,
      focused: false,
      width: 500,
      height: 600,
    })
  })
  test('missing native discovery falls back, empty/error/disabled does not', async () => {
    const f = fixture()
    Reflect.deleteProperty(f.api.action, 'getPopup')
    expect((await popout.open({ source: 'popup' })).page).toBe(
      f.base + 'manifest.html'
    )
    f.api.action.getPopup = async () => ''
    await expect(popout.open({ source: 'popup' })).rejects.toMatchObject({
      code: 'CONTEXT_UNAVAILABLE',
    })
    f.api.action.getPopup = async () => {
      throw new Error('permission denied')
    }
    await expect(popout.open({ source: 'popup' })).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    })
    if ('sidePanel' in f.api)
      f.api.sidePanel.getOptions = async () => ({
        path: 'panel.html',
        enabled: false,
      })
    await expect(popout.open({ source: 'sidePanel' })).rejects.toMatchObject({
      code: 'CONTEXT_UNAVAILABLE',
    })
  })
  test('invalid arguments are rejected before creation', async () => {
    const f = fixture()
    for (const bad of [
      null,
      {},
      { source: 'bad' },
      { source: 'popup', width: 0 },
      { source: 'popup', height: NaN },
      { source: 'popup', left: 1.5 },
      { source: 'popup', focused: 'yes' },
      { source: 'popup', sourceTarget: { tabId: 1, windowId: 2 } },
      { source: 'popup', associatedTabId: -1 },
      { source: 'popup', reuseKey: '' },
      { source: 'popup', tabId: 3 },
    ])
      await expect(popout.open(bad as never)).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      })
    for (const page of [
      'https://example.com',
      'javascript:alert(1)',
      'data:text/html,hi',
      'blob:https://example.com/id',
      'chrome-extension://other/ui.html',
      'chrome-extension://user@self/ui.html',
      `ui.html?${PARAM}=spoof`,
    ])
      await expect(
        popout.open({ source: 'popup', page })
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(f.calls).toHaveLength(0)
  })
  test('association stays fixed across movement, missing tabs only suppress confirmed deletion', async () => {
    const f = fixture()
    f.tabs.set(7, {
      id: 7,
      windowId: 100,
      index: 0,
      active: false,
      pinned: false,
    })
    const h = await popout.open({ source: 'popup', associatedTabId: 7 })
    expect((await h.getTab()).url).toBeUndefined()
    expect(await h.tabExists()).toBe(true)
    f.tabs.get(7)!.windowId = 200
    await h.activateTab()
    expect(f.calls.at(-1)).toEqual({
      path: 'focus',
      args: [200, { focused: true }],
    })
    f.tabs.delete(7)
    expect(await h.tabExists()).toBe(false)
    await expect(h.activateTab()).rejects.toMatchObject({
      code: 'TAB_NOT_FOUND',
    })
    f.api.tabs.get = async () => {
      throw new Error('permission denied')
    }
    await expect(h.tabExists()).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    })
    expect(h.associatedTabId).toBe(7)
  })
  test('fresh manager restores ready and interrupted pending records without trusting copied tokens', async () => {
    const f = fixture()
    const h = await popout.open({ source: 'popup', reuseKey: 'restore' })
    const name = Object.keys(f.data)[0]!,
      record = f.data[name] as Record<string, unknown>
    record.status = 'pending'
    delete record.windowId
    delete record.tabId
    const fresh = new PopoutManager()
    expect((await fresh.get(h.windowId))?.status).toBe('ready')
    const own = [...f.tabs.values()][0]!
    global('location', { href: own.url })
    f.api.tabs.getCurrent = async () => ({ ...own, id: 999 })
    // getCurrent is a reader RPC; use background identity to exercise the owner directly.
    expect(await popout.getCurrent()).toBeUndefined()
    f.api.tabs.getCurrent = async () => own
    expect((await popout.getCurrent())?.windowId).toBe(h.windowId)
  })
  test('ambiguous pending matches fail without adopting either window', async () => {
    const f = fixture()
    const h = await popout.open({ source: 'popup' })
    const record = f.data[Object.keys(f.data)[0]!] as Record<string, unknown>
    record.status = 'pending'
    delete record.windowId
    delete record.tabId
    const original = f.windows.get(h.windowId)!,
      tab = [...f.tabs.values()][0]!
    f.windows.set(90, {
      ...original,
      id: 90,
      tabs: [{ ...tab, id: 91, windowId: 90 }],
    })
    await expect(new PopoutManager().get(h.windowId)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    expect(record.status).toBe('pending')
  })
  test('closed, navigated, moved and orphaned records expire; arbitrary windows stay open', async () => {
    const f = fixture()
    const h = await popout.open({ source: 'popup', reuseKey: 'one' })
    const window = f.windows.get(h.windowId)!
    ;(window.tabs as Record<string, unknown>[])[0]!.url = f.base + 'other.html'
    expect(await popout.get(h.windowId)).toBeUndefined()
    expect(Object.keys(f.data)).toHaveLength(0)
    await popout.close(h.windowId)
    expect(f.windows.has(h.windowId)).toBe(true)
    const next = await popout.open({ source: 'popup', reuseKey: 'one' })
    expect(next.windowId).not.toBe(h.windowId)
    f.windows.delete(next.windowId)
    expect(await popout.get(next.windowId)).toBeUndefined()
    const orphanToken = 'orphan_token_123456789'
    f.data[PREFIX + orphanToken] = {
      version: 1,
      status: 'pending',
      token: orphanToken,
      source: 'popup',
      page: f.base + 'ui.html',
      options: { source: 'popup', page: f.base + 'ui.html' },
      bounds: {},
    }
    await f.manager.reconcile()
    expect(f.data[PREFIX + orphanToken]).toBeUndefined()
  })
  test('record commit failure compensates newly created window', async () => {
    const f = fixture()
    const set = f.api.storage.session.set
    f.api.storage.session.set = async (value) => {
      if (
        Object.values(value).some(
          (v) => (v as Record<string, unknown>).status === 'ready'
        )
      )
        throw new Error('quota exceeded')
      await set(value)
    }
    await expect(popout.open({ source: 'popup' })).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
    })
    expect(f.windows.size).toBe(0)
    expect(Object.keys(f.data)).toHaveLength(0)
  })
  test('failed compensation reports window ID and both causes, leaving recovery record', async () => {
    const f = fixture()
    const set = f.api.storage.session.set
    f.api.storage.session.set = async (value) => {
      if (
        Object.values(value).some(
          (v) => (v as Record<string, unknown>).status === 'ready'
        )
      )
        throw new Error('commit failed')
      await set(value)
    }
    f.api.windows.remove = async () => {
      throw new Error('remove failed')
    }
    await expect(popout.open({ source: 'popup' })).rejects.toMatchObject({
      code: 'NATIVE_ERROR',
      cause: { message: 'commit failed' },
      details: { windowId: 10, compensation: { code: 'NATIVE_ERROR' } },
    })
    expect(Object.keys(f.data)).toHaveLength(1)
  })
  test('pre-create storage failure causes no window mutation, native get errors are not absence', async () => {
    const f = fixture()
    f.api.storage.session.set = async () => {
      throw new Error('permission denied')
    }
    await expect(popout.open({ source: 'popup' })).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    })
    expect(f.windows.size).toBe(0)
    f.api.windows.getAll = async () => {
      throw new Error('native broken')
    }
    await expect(popout.get(1)).rejects.toMatchObject({ code: 'NATIVE_ERROR' })
  })
  test('closeOriginal from another UI is observable and never loses successful creation', async () => {
    const f = fixture()
    const h = await popout.open({ source: 'popup', closeOriginal: true })
    expect(h.originalUiClose.status).toBe('unsupported')
    expect(h.windowId).toBeGreaterThan(0)
    Reflect.set(f.api.runtime, 'getContexts', async () => {
      throw Error('native context failure')
    })
    const failed = await popout.open({ source: 'popup', closeOriginal: true })
    expect(failed.originalUiClose).toMatchObject({
      status: 'failed',
      error: { code: 'NATIVE_ERROR' },
    })
  })
  test('getCurrent ignores plain pages, missing token and nested frames', async () => {
    const f = fixture()
    expect(await popout.getCurrent()).toBeUndefined()
    const h = await popout.open({ source: 'popup' })
    global('location', { href: [...f.tabs.values()][0]!.url })
    f.win.top = {}
    expect(await popout.getCurrent()).toBeUndefined()
    f.win.top = f.win
    global('location', {
      href: `https://example.com/?${PARAM}=untrusted_token_12345`,
    })
    expect(await popout.getCurrent()).toBeUndefined()
    global('location', { href: f.base + 'background.html' })
    await h.close()
  })
  test('missing Web Locks is explicit and SSR import is safe', async () => {
    fixture()
    global('navigator', {})
    await expect(popout.open({ source: 'popup' })).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
    })
    global('window', undefined)
    global('document', undefined)
    global('chrome', undefined)
    await expect(popout.open({ source: 'popup' })).rejects.toMatchObject({
      code: 'CONTEXT_UNAVAILABLE',
    })
  })
  test('Firefox initial loading placeholder is retried before expiring ownership', async () => {
    const f = fixture(true),
      h = await popout.open({ source: 'popup', reuseKey: 'loading' })
    const tab = (
        f.windows.get(h.windowId)!.tabs as Record<string, unknown>[]
      )[0]!,
      url = tab.url
    tab.url = 'about:blank'
    tab.status = 'loading'
    setTimeout(() => {
      tab.url = url
      tab.status = 'complete'
    }, 40)
    expect((await popout.get(h.windowId))?.windowId).toBe(h.windowId)
    expect(
      (await popout.open({ source: 'popup', reuseKey: 'loading' })).windowId
    ).toBe(h.windowId)
    tab.url = 'about:blank'
    tab.status = 'complete'
    expect(await popout.get(h.windowId)).toBeUndefined()
  })
  test('irrelevant updates avoid scans; managed bursts coalesce and navigation still cleans', async () => {
    const f = fixture(),
      stop = f.manager.startBackground()
    try {
      await f.manager.locked(async () => {})
      const baseline = f.calls.filter((c) => c.path === 'getAll').length
      for (let i = 0; i < 50; i++)
        for (const cb of f.onUpdated.callbacks) cb(999, { title: `title${i}` })
      await f.manager.locked(async () => {})
      expect(f.calls.filter((c) => c.path === 'getAll').length).toBe(baseline)
      const handle = await f.manager.open({ source: 'popup' })
      const count = f.calls.filter((c) => c.path === 'getAll').length
      for (let i = 0; i < 50; i++)
        for (const cb of f.onUpdated.callbacks) cb(999, { status: 'complete' })
      for (let i = 0; i < 50; i++)
        for (const cb of f.onUpdated.callbacks)
          cb(handle.tabId, { title: 'managed title' })
      await f.manager.locked(async () => {})
      expect(f.calls.filter((c) => c.path === 'getAll').length).toBe(count)
      for (let i = 0; i < 50; i++)
        for (const cb of f.onUpdated.callbacks)
          cb(handle.tabId, { status: 'complete' })
      await f.manager.locked(async () => {})
      await f.manager.locked(async () => {})
      expect(
        f.calls.filter((c) => c.path === 'getAll').length - count
      ).toBeLessThanOrEqual(2)
      const tab = (
        f.windows.get(handle.windowId)!.tabs as Record<string, unknown>[]
      )[0]!
      tab.url = f.base + 'unmanaged.html'
      for (const cb of f.onUpdated.callbacks) cb(handle.tabId, { url: tab.url })
      await f.manager.locked(async () => {})
      expect(Object.keys(f.data)).toHaveLength(0)
      expect(f.windows.has(handle.windowId)).toBe(true)
    } finally {
      stop()
    }
    expect(f.onUpdated.callbacks.size).toBe(0)
  })
  test('Background RPC rejects page/content/foreign senders; listeners clean up and stale handles do not close replacements', async () => {
    const f = fixture(),
      stop = f.manager.startBackground()
    const invoke = async (sender: MessageSender, value: unknown) =>
      await currentRealm().dispatch(
        {
          protocol: '@midra/webext-utils/messaging',
          version: 1,
          type: 'request',
          id: crypto.randomUUID(),
          deadline: Date.now() + 1000,
          name: '__webext_utils__popout_rpc_v1',
          target: { context: 'background' },
          mode: 'send',
          data: value,
        } as Request,
        sender
      )
    const own: MessageSender = {
      id: 'self',
      context: 'extension-page',
      trust: 'extension',
      url: f.base + 'ui.html',
    }
    for (const sender of [
      { ...own, trust: 'page' as const },
      { ...own, context: 'content-script' as const },
      { ...own, id: 'other' },
      { ...own, url: 'https://example.com' },
      { ...own, url: 'chrome-extension://self.evil/ui.html' },
    ]) {
      expect(
        await invoke(sender, { operation: 'open', value: { source: 'popup' } })
      ).toMatchObject({ ok: false, error: { code: 'ACCESS_DENIED' } })
    }
    expect(
      await invoke(own, {
        operation: 'open',
        value: { source: 'popup', width: -1 },
      })
    ).toMatchObject({
      ok: true,
      value: { ok: false, error: { code: 'INVALID_ARGUMENT' } },
    })
    expect(
      await invoke(own, { operation: 'open', value: { source: 'popup' } })
    ).toMatchObject({
      ok: true,
      value: { ok: true, value: { status: 'ready' } },
    })
    expect(f.onRemoved.callbacks.size).toBe(1)
    expect(() => f.manager.startBackground()).toThrow('already registered')
    const windowId = [...f.windows.keys()][0]!
    f.windows.delete(windowId)
    for (const cb of f.onRemoved.callbacks) cb(windowId)
    await f.manager.locked(async () => {})
    expect(Object.keys(f.data)).toHaveLength(0)
    stop()
    stop()
    expect(f.onRemoved.callbacks.size).toBe(0)
    expect(f.onTabRemoved.callbacks.size).toBe(0)
    expect(f.onUpdated.callbacks.size).toBe(0)
    expect(f.onAttached.callbacks.size).toBe(0)
  })
  test('RPC compensation errors retain created window and both failures', async () => {
    const f = fixture(),
      stop = f.manager.startBackground()
    try {
      const set = f.api.storage.session.set
      f.api.storage.session.set = async (value) => {
        if (
          Object.values(value).some(
            (v) => (v as Record<string, unknown>).status === 'ready'
          )
        )
          throw Error('commit failure')
        await set(value)
      }
      f.api.windows.remove = async () => {
        throw Error('compensation failure')
      }
      const reply = await currentRealm().dispatch(
        {
          protocol: '@midra/webext-utils/messaging',
          version: 1,
          type: 'request',
          id: crypto.randomUUID(),
          deadline: Date.now() + 1000,
          name: '__webext_utils__popout_rpc_v1',
          target: { context: 'background' },
          mode: 'send',
          data: { operation: 'open', value: { source: 'popup' } },
        },
        {
          id: 'self',
          context: 'extension-page',
          trust: 'extension',
          url: f.base + 'ui.html',
        }
      )
      expect(reply).toMatchObject({
        ok: true,
        value: {
          ok: false,
          error: {
            cause: { message: 'commit failure' },
            details: {
              windowId: 10,
              compensation: { message: 'compensation failure' },
            },
          },
        },
      })
    } finally {
      stop()
    }
  })
  test('closeOriginal confirms popup closure and reports a native side panel close failure independently', async () => {
    const f = fixture()
    Reflect.set(f.api.extension, 'getBackgroundPage', () => undefined)
    Reflect.set(f.api.extension, 'getViews', (q: { type: string }) =>
      q.type === 'popup' ? [f.win] : []
    )
    Reflect.set(f.win, 'closed', false)
    Reflect.set(f.win, 'close', () => Reflect.set(f.win, 'closed', true))
    expect(
      (await popout.open({ source: 'popup', closeOriginal: true }))
        .originalUiClose.status
    ).toBe('closed')
    global('location', { href: f.base + 'source-panel.html' })
    Reflect.set(f.api.extension, 'getViews', () => [])
    Reflect.set(f.api.windows, 'getCurrent', async () => ({ id: 50 }))
    f.api.tabs.getCurrent = async () => undefined as never
    Reflect.set(f.api.runtime, 'getContexts', async () => [
      {
        contextType: 'SIDE_PANEL',
        documentUrl: f.base + 'source-panel.html',
        windowId: 50,
        tabId: -1,
        frameId: 0,
      },
    ])
    if ('sidePanel' in f.api)
      Reflect.set(f.api.sidePanel, 'close', async () => {
        throw Error('user gesture required')
      })
    const result = await popout.open({
      source: 'sidePanel',
      closeOriginal: true,
    })
    expect(result.originalUiClose).toMatchObject({
      status: 'failed',
      error: { code: 'USER_GESTURE_REQUIRED' },
    })
    expect(result.windowId).toBeGreaterThan(0)
  })
})
