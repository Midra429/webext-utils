import type { PageBridge } from '../src/messaging'
import type { StorageBackgroundOptions } from '../src/storage'

import { describe, expect, test } from 'bun:test'

import { IsolatedBridge } from '../src/messaging/page-bridge'
import { PageClient } from '../src/messaging/page-client'
import { PageEnvironment } from '../src/messaging/page-wire'
import { Realm } from '../src/messaging/realm'
import { createStorage } from '../src/storage/client'
import { expose } from '../src/storage/page'
import { StorageRuntime } from '../src/storage/runtime'
import { NativeBus } from './helpers/messaging-native'
import { StorageNative } from './helpers/storage-native'

class Surface extends PageEnvironment {
  override document = new EventTarget() as unknown as Document
  override window = new EventTarget() as unknown as Window & typeof globalThis
  override origin() {
    return 'https://example.com'
  }
  override href() {
    return 'https://example.com/page'
  }
  override emit(type: string, detail: string) {
    this.document.dispatchEvent(new CustomEvent(type, { detail }))
  }
}
type Schema = {
  'settings.theme': 'dark' | 'light'
  'settings.language': string
  'settings.secret': string
  'settingsExtra.theme': string
}
const tick = () => new Promise((r) => setTimeout(r, 20))
function setup(options?: StorageBackgroundOptions) {
  const native = new StorageNative(),
    bus = new NativeBus()
  const bgEnv = bus.realm('background'),
    csEnv = bus.realm('content-script', {
      tab: { id: 7, windowId: 2 },
      frameId: 0,
      documentId: 'doc',
    })
  for (const env of [bgEnv, csEnv])
    env.api.storage = { ...native.api, onChanged: native.onChanged }
  const bg = new Realm(bgEnv.env),
    cs = new Realm(csEnv.env)
  const stopRouter = bg.startBackground()
  const bgRuntime = new StorageRuntime(
    bgEnv.env,
    () => bg,
    () => native.locks.manager
  )
  const csRuntime = new StorageRuntime(
    csEnv.env,
    () => cs,
    () => native.locks.manager
  )
  let stopStorage = bgRuntime.startBackground(options)
  const trusted = createStorage<Schema>({}, () => bgRuntime),
    content = createStorage<Schema>({}, () => csRuntime)
  async function cleanup() {
    stopStorage()
    await cs.ready()
    await tick()
    stopRouter()
    bus.disconnect()
  }
  function restart() {
    stopStorage()
    stopRouter()
    const router = bg.startBackground()
    stopStorage = bgRuntime.startBackground(options)
    return router
  }
  return {
    native,
    bus,
    bg,
    cs,
    bgEnv,
    csEnv,
    bgRuntime,
    csRuntime,
    trusted,
    content,
    cleanup,
    restart,
  }
}
describe('final review subscription registration and lifecycle', () => {
  const metadata = '__webext_utils__storage_subscriptions_v1'
  for (const [message, code] of [
    ['QUOTA_BYTES', 'QUOTA_EXCEEDED'],
    ['permission denied', 'PERMISSION_DENIED'],
  ] as const) {
    test(`watch.ready exposes ${code} even when CRUD succeeds`, async () => {
      const s = setup(),
        errors: unknown[] = []
      s.native.failure = (area, method, arg) => {
        if (
          area === 'session' &&
          method === 'set' &&
          Object.hasOwn(arg as object, metadata)
        )
          throw Error(message)
      }
      const stop = s.content.watch(
        'settings.theme',
        () => {
          throw Error('must not deliver')
        },
        { onError: (e) => errors.push(e.code) }
      )
      await expect(stop.ready).rejects.toMatchObject({ code })
      await s.content.set('settings.theme', 'dark')
      expect(await s.content.get('settings.theme')).toBe('dark')
      expect(errors).toEqual([code])
      stop()
      stop()
      s.native.failure = undefined
      await tick()
      expect(s.bus.activePorts()).toBe(0)
      expect(s.csEnv.onMessage.listeners.size).toBe(0)
      await s.cleanup()
    })
  }
  test('unsubscribe during registration rejects ready and removes late accepted metadata', async () => {
    const s = setup(),
      events: unknown[] = []
    let entered!: () => void, release!: () => void
    const begun = new Promise<void>((r) => {
      entered = r
    })
    const barrier = new Promise<void>((r) => {
      release = r
    })
    const send = s.bgRuntime.engine.call.bind(s.bgRuntime.engine)
    s.bgRuntime.engine.call = async (area, method, ...args) => {
      if (
        area === 'session' &&
        method === 'set' &&
        Object.hasOwn(args[0] as object, metadata)
      ) {
        entered()
        await barrier
      }
      return await send(area, method, ...args)
    }
    const stop = s.content.watch('settings.theme', (c) => events.push(c))
    await begun
    stop()
    await expect(stop.ready).rejects.toMatchObject({ code: 'TRANSPORT_CLOSED' })
    release()
    await tick()
    await tick()
    expect(s.native.data.session[metadata]).toEqual({})
    await s.trusted.set('settings.theme', 'dark')
    await tick()
    expect(events).toEqual([])
    expect(s.bus.activePorts()).toBe(0)
    await s.cleanup()
  })
  test('registration timeout is observable and late acceptance is removed', async () => {
    const s = setup(),
      errors: string[] = []
    let release!: () => void
    const barrier = new Promise<void>((r) => {
      release = r
    })
    const call = s.bgRuntime.engine.call.bind(s.bgRuntime.engine)
    s.bgRuntime.engine.call = async (area, method, ...args) => {
      if (
        area === 'session' &&
        method === 'set' &&
        Object.hasOwn(args[0] as object, metadata)
      )
        await barrier
      return await call(area, method, ...args)
    }
    const stop = s.content.watch('settings.theme', () => {}, {
      onError: (e) => errors.push(e.code),
    })
    try {
      await expect(stop.ready).rejects.toMatchObject({ code: 'TIMEOUT' })
      expect(errors).toEqual(['TIMEOUT'])
    } finally {
      release()
      stop()
      await tick()
      await tick()
      expect(s.native.data.session[metadata]).toEqual({})
      await s.cleanup()
    }
  }, 20000)
  test('missing router rejects registration and a failed reconnect reports onError', async () => {
    const missing = setup()
    await missing.cleanup()
    const failed = missing.content.watch('settings.theme', () => {})
    await expect(failed.ready).rejects.toMatchObject({
      code: 'TRANSPORT_CLOSED',
    })
    failed()
    await tick()
    expect(missing.bus.activePorts()).toBe(0)
    const s = setup(),
      errors: string[] = []
    const stop = s.content.watch('settings.theme', () => {}, {
      onError: (e) => errors.push(e.code),
    })
    try {
      await stop.ready
      s.bus.disconnect()
      s.native.failure = (area, method, arg) => {
        if (
          area === 'session' &&
          method === 'set' &&
          Object.keys(arg as object).some((k) =>
            k.startsWith('__webext_utils_messaging_v1__:')
          )
        )
          throw Error('permission denied')
      }
      await s.trusted.set('settings.theme', 'dark')
      await tick()
      await tick()
      expect(errors).toEqual(['NATIVE_ERROR'])
    } finally {
      s.native.failure = undefined
      stop()
      await tick()
      await s.cleanup()
    }
  })
  test('a vanished subframe is pruned on disconnect without a key or tab update', async () => {
    const s = setup()
    const stop = s.content.watch('settings.language', () => {})
    await stop.ready
    s.bus.disconnect()
    s.bus.realms.splice(s.bus.realms.indexOf(s.csEnv), 1)
    await tick()
    await tick()
    expect(s.native.data.session[metadata]).toEqual({})
    stop()
    await s.cleanup()
  })
  test('selected RPC watchAll excludes another schema and nested legacy data', async () => {
    const s = setup(),
      events: unknown[] = []
    const stop = s.content
      .namespace('settings')
      .watchAll(['theme'], (c) => events.push(c))
    await stop.ready
    const other = createStorage<{ 'settings.count': number }>(
      {},
      () => s.bgRuntime
    )
    await other.set('settings.count', 42)
    s.native.emit({ 'settings.old.nested': { newValue: true } }, 'local')
    await s.trusted.set('settings.theme', 'dark')
    await tick()
    expect(events).toEqual([
      { key: 'theme', oldValue: undefined, newValue: 'dark' },
    ])
    stop()
    await s.cleanup()
  })
  test('navigation cleans silent dead documents and preserves the new document subscription', async () => {
    const s = setup(),
      events: unknown[] = []
    const old = s.content.watch('settings.language', () => {})
    await old.ready
    s.bus.disconnect()
    s.bus.realms.splice(s.bus.realms.indexOf(s.csEnv), 1)
    const native = s.bus.realm('content-script', {
      tab: { id: 7, windowId: 2 },
      frameId: 0,
      documentId: 'new-doc',
    })
    native.api.storage = { ...s.native.api, onChanged: s.native.onChanged }
    const realm = new Realm(native.env),
      runtime = new StorageRuntime(
        native.env,
        () => realm,
        () => s.native.locks.manager
      )
    const fresh = createStorage<Schema>({}, () => runtime)
    const stop = fresh.watch('settings.theme', (c) => events.push(c))
    await stop.ready
    for (const cb of s.bus.onTabUpdated.listeners) cb(7, { status: 'complete' })
    await tick()
    await tick()
    expect(
      Object.values(s.native.data.session[metadata] as object)
    ).toHaveLength(1)
    await s.trusted.set('settings.theme', 'dark')
    await tick()
    expect(events).toHaveLength(1)
    for (const cb of s.bus.onTabRemoved.listeners) cb(7)
    await tick()
    expect(s.native.data.session[metadata]).toEqual({})
    old()
    stop()
    await s.cleanup()
    expect(s.bus.onTabRemoved.listeners.size).toBe(0)
    expect(s.bus.onTabUpdated.listeners.size).toBe(0)
  })
  test('1024 stale records cannot block a new valid subscription; live cap errors are observable', async () => {
    const s = setup()
    s.native.data.session[metadata] = Object.fromEntries(
      Array.from({ length: 1024 }, (_, i) => [
        crypto.randomUUID(),
        {
          area: 'local',
          prefix: '',
          keys: ['neverChanges'],
          receiver: `__webext_utils__storage_watch_dead${i}`,
          target: {
            context: 'content-script',
            world: 'ISOLATED',
            tabId: 900 + i,
            frameId: 0,
            documentId: `dead${i}`,
            instanceId: `dead${i}`,
          },
        },
      ])
    )
    const stop = s.content.watch('settings.theme', () => {})
    await stop.ready
    expect(Object.keys(s.native.data.session[metadata] as object)).toHaveLength(
      1
    )
    // All records now deliberately name the same living endpoint. Capacity is
    // genuine, so liveness pruning must preserve them and report quota.
    const live = Object.values(s.native.data.session[metadata] as object)[0]
    s.native.data.session[metadata] = Object.fromEntries(
      Array.from({ length: 1024 }, () => [crypto.randomUUID(), live])
    )
    const denied = s.content.watch('settings.language', () => {})
    await expect(denied.ready).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
    denied()
    stop()
    await s.cleanup()
  })
})
describe('Content Script storage RPC', () => {
  test('CRUD goes through Background; default session is denied without changing native access', async () => {
    const s = setup()
    await s.content.set('settings.theme', 'dark')
    expect(
      await s.content.getMany(['settings.theme', 'settings.language'])
    ).toEqual({ 'settings.theme': 'dark', 'settings.language': undefined })
    expect(
      s.bus.sends.some(
        (v) => (v as { name: string }).name === '__webext_utils__storage_rpc_v1'
      )
    ).toBe(true)
    await expect(
      createStorage<Schema>({ area: 'session' }, () => s.csRuntime).set(
        'settings.theme',
        'dark'
      )
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    expect(s.native.data.session['settings.theme']).toBeUndefined()
    await expect(
      s.content.migrate({ version: 0, steps: {} })
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    await s.content.remove('settings.theme')
    expect(await s.content.get('settings.theme')).toBeUndefined()
    await s.cleanup()
  })
  test('explicit area control, missing router and native errors propagate', async () => {
    const s = setup({ contentScriptAccess: { local: false, session: true } })
    await expect(s.content.get('settings.theme')).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
    })
    const session = createStorage<Schema>(
      { area: 'session' },
      () => s.csRuntime
    )
    await session.set('settings.theme', 'dark')
    expect(await session.get('settings.theme')).toBe('dark')
    s.native.failure = () => {
      throw Error('QUOTA_BYTES')
    }
    await expect(session.set('settings.theme', 'light')).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
    })
    s.native.failure = undefined
    await s.cleanup()
    await expect(s.content.get('settings.theme')).rejects.toMatchObject({
      code: 'ROUTER_UNAVAILABLE',
    })
  })
  test('watch streams native changes once, filters area/namespace, cleans registration', async () => {
    const s = setup(),
      events: unknown[] = []
    const stop = s.content.namespace('settings').watchAll((c) => events.push(c))
    await tick()
    expect(events).toEqual([])
    await s.trusted.setMany({
      'settings.theme': 'dark',
      'settingsExtra.theme': 'secret',
    })
    await tick()
    expect(events).toEqual([
      { key: 'theme', oldValue: undefined, newValue: 'dark' },
    ])
    await s.content.set('settings.theme', 'light')
    await tick()
    expect(events).toHaveLength(2)
    await s.content.remove('settings.theme')
    await tick()
    expect(events).toHaveLength(3)
    expect(events[2]).toMatchObject({ oldValue: 'light', newValue: undefined })
    stop()
    stop()
    await tick()
    expect(s.bus.activePorts()).toBe(0)
    expect(s.csEnv.onMessage.listeners.size).toBe(0)
    expect(s.native.onChanged.listeners.size).toBe(1)
    await s.cleanup()
    expect(s.native.onChanged.listeners.size).toBe(0)
  })
  test('idle subscription survives router restart and reconnects only on delivery', async () => {
    const s = setup(),
      events: unknown[] = []
    const stop = s.content.watch('settings.theme', (c) => events.push(c))
    await tick()
    s.bus.disconnect()
    const before = s.bus.connects
    const stopNewRouter = s.restart()
    await tick()
    expect(s.bus.connects).toBe(before)
    await s.trusted.set('settings.theme', 'dark')
    await tick()
    expect(events).toEqual([
      { key: 'settings.theme', oldValue: undefined, newValue: 'dark' },
    ])
    expect(s.bus.connects).toBeGreaterThan(before)
    stop()
    await tick()
    stopNewRouter()
    await s.cleanup()
  })
  test('external CRUD waits for a Background migration instead of being mistaken for reentry', async () => {
    const s = setup()
    let release!: () => void, entered!: () => void
    const barrier = new Promise<void>((r) => {
      release = r
    })
    const started = new Promise<void>((r) => {
      entered = r
    })
    const migration = s.trusted.namespace('settings').migrate({
      version: 1,
      steps: {
        1: async (d) => {
          entered()
          await barrier
          d.set('theme', 'light')
        },
      },
    })
    await started
    let finished = false
    const external = s.content.get('settings.theme').then((value) => {
      finished = true
      return value
    })
    await tick()
    expect(finished).toBe(false)
    release()
    await migration
    expect(await external).toBe('light')
    await s.cleanup()
  })
  test('page-marked requests cannot access internal storage service', async () => {
    const s = setup()
    await expect(
      s.cs.send(
        '__webext_utils__storage_rpc_v1',
        {
          area: 'session',
          operation: 'get',
          keys: ['settings.secret'],
          values: {},
        },
        { target: { context: 'background' } },
        'send',
        new Set(),
        true,
        true
      )
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    await s.cleanup()
  })
})
describe('MAIN storage policy', () => {
  function pageSetup() {
    const s = setup(),
      surface = new Surface()
    const bridge = new IsolatedBridge(
      s.cs,
      {
        channel: 'storage-public',
        allowedOrigins: ['https://example.com'],
        fromPage: {},
        toPage: {},
      },
      surface
    )
    const policy = {
      read: ['theme', 'language'] as const,
      write: ['theme'] as const,
      watch: ['theme'] as const,
      validate: {
        theme: (v: unknown): v is 'dark' | 'light' =>
          v === 'dark' || v === 'light',
        language: (v: unknown): v is string => typeof v === 'string',
      },
    }
    const stopExpose = s.content
      .namespace('settings')
      .exposeToPage(bridge, policy)
    // A local page environment is injected at the transport boundary, with no browser globals.
    const messaging = PageClient.create('storage-public', surface)
    const page = createStorage<Schema>({
      bridge: { channel: 'storage-public' },
    })
    // PageStorage resolves the shared channel by document. Bind only the runtime document used by PageClient.
    const original = Object.getOwnPropertyDescriptor(globalThis, 'document')
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: surface.document,
    })
    return {
      ...s,
      surface,
      bridge,
      stopExpose,
      page,
      messaging,
      restore() {
        if (original) Object.defineProperty(globalThis, 'document', original)
        else Reflect.deleteProperty(globalThis, 'document')
      },
      async finish() {
        stopExpose()
        messaging.dispose()
        bridge.dispose()
        this.restore()
        await s.cleanup()
      },
    }
  }
  test('prototype-named keys survive RPC, MAIN reads and snapshot recovery', async () => {
    const s = pageSetup()
    type Keys = { toString: string }
    const trusted = createStorage<Keys>({}, () => s.bgRuntime)
    const content = createStorage<Keys>({}, () => s.csRuntime)
    const page = createStorage<Keys>({ bridge: { channel: 'storage-public' } })
    const stopExpose = content.exposeToPage(s.bridge, {
      read: ['toString'],
      write: ['toString'],
      watch: ['toString'],
      validate: { toString: (v): v is string => typeof v === 'string' },
    })
    const events: unknown[] = []
    let stop: (() => void) | undefined
    const lifecycle = (type: string) => {
      const event = new Event(type)
      Object.defineProperty(event, 'persisted', { value: true })
      s.surface.window.dispatchEvent(event)
    }
    try {
      expect(await content.get('toString')).toBeUndefined()
      expect(await page.get('toString')).toBeUndefined()
      const subscription = page.watch('toString', (c) => events.push(c))
      stop = subscription
      await subscription.ready
      await page.set('toString', 'saved')
      await tick()
      expect(await page.get('toString')).toBe('saved')
      lifecycle('pagehide')
      await tick()
      await trusted.remove('toString')
      lifecycle('pageshow')
      await tick()
      await tick()
      expect(events).toEqual([
        { key: 'toString', oldValue: undefined, newValue: 'saved' },
        { key: 'toString', oldValue: 'saved', newValue: undefined },
      ])
      expect(await page.get('toString')).toBeUndefined()
    } finally {
      stop?.()
      stopExpose()
      await tick()
      await s.finish()
    }
  })
  test('MAIN ready exposes denied watch and subscription-specific native failures', async () => {
    const s = pageSetup()
    try {
      const denied = s.page.watch('settings.secret', () => {})
      await expect(denied.ready).rejects.toMatchObject({
        code: 'ACCESS_DENIED',
      })
      denied()
      const errors: string[] = []
      s.native.failure = (area, method, arg) => {
        if (
          area === 'session' &&
          method === 'set' &&
          Object.hasOwn(
            arg as object,
            '__webext_utils__storage_subscriptions_v1'
          )
        )
          throw Error('QUOTA_BYTES')
      }
      const failed = s.page.watch('settings.theme', () => {}, {
        onError: (e) => errors.push(e.code),
      })
      await expect(failed.ready).rejects.toMatchObject({
        code: 'QUOTA_EXCEEDED',
      })
      expect(errors).toEqual(['QUOTA_EXCEEDED'])
      failed()
      s.native.failure = undefined
      expect(await s.page.get('settings.theme')).toBeUndefined()
    } finally {
      await tick()
      await s.finish()
    }
  })
  test('MAIN re-registration failures are reported and release the failed observer', async () => {
    const s = pageSetup(),
      errors: string[] = [],
      events: unknown[] = []
    const stop = s.page.watchAll(['settings.theme'], (c) => events.push(c), {
      onError: (e) => errors.push(e.code),
    })
    const lifecycle = (type: string) => {
      const event = new Event(type)
      Object.defineProperty(event, 'persisted', { value: true })
      s.surface.window.dispatchEvent(event)
    }
    try {
      await stop.ready
      lifecycle('pagehide')
      await tick()
      s.stopExpose()
      lifecycle('pageshow')
      await tick()
      await tick()
      expect(errors).toEqual(['ACCESS_DENIED'])
      await s.trusted.set('settings.theme', 'dark')
      await tick()
      expect(events).toEqual([])
    } finally {
      stop()
      await tick()
      await s.finish()
    }
  })
  test('read/write ACL, namespace expansion, validator and full batch rejection', async () => {
    const s = pageSetup()
    try {
      await s.page.set('settings.theme', 'dark')
      expect(await s.page.get('settings.theme')).toBe('dark')
      for (const k of ['settings.secret', 'settingsExtra.theme'])
        await expect(s.page.get(k as 'settings.theme')).rejects.toMatchObject({
          code: 'ACCESS_DENIED',
        })
      await expect(
        s.page.setMany({ 'settings.theme': 'light', 'settings.language': 'en' })
      ).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
      expect(await s.trusted.get('settings.theme')).toBe('dark')
      await expect(
        s.page.set('settings.theme', 'bad' as 'dark')
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
      s.native.data.local['settings.theme'] = 123
      await expect(s.page.get('settings.theme')).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      })
      await expect(
        createStorage<Schema>({
          area: 'session',
          bridge: { channel: 'storage-public' },
        }).get('settings.theme')
      ).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
      await expect(
        s.page.migrate({ version: 0, steps: {} })
      ).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
      expect(() => s.page.exposeToPage(s.bridge, { validate: {} })).toThrow()
      await s.page.remove('settings.theme') // removal does not validate the old value
      expect(await s.trusted.get('settings.theme')).toBeUndefined()
    } finally {
      await s.finish()
    }
  })
  test('watchAll expands permitted keys only; invalid native values and secret events do not leak', async () => {
    const s = pageSetup(),
      events: unknown[] = []
    let stop: () => void = () => {}
    try {
      stop = s.page.namespace('settings').watchAll((c) => events.push(c))
      await tick()
      await s.trusted.setMany({
        'settings.theme': 'dark',
        'settings.language': 'ja',
        'settings.secret': 'hidden',
      })
      await tick()
      expect(events).toEqual([
        { key: 'theme', oldValue: undefined, newValue: 'dark' },
      ])
      s.native.emit(
        { 'settings.theme': { oldValue: 'dark', newValue: 'invalid' } },
        'local'
      )
      await tick()
      expect(events).toHaveLength(1)
      await s.trusted.remove('settings.theme')
      await tick()
      expect(events).toHaveLength(2)
      s.stopExpose()
      await s.trusted.set('settings.theme', 'light')
      await tick()
      expect(events).toHaveLength(2)
      await expect(s.page.get('settings.theme')).rejects.toMatchObject({
        code: 'ACCESS_DENIED',
      })
    } finally {
      stop()
      await tick()
      await s.finish()
    }
  })
  test('BFCache resume restores the subscription and refreshes the latest snapshot', async () => {
    const s = pageSetup(),
      events: unknown[] = []
    const stop = s.page.watch('settings.theme', (c) => events.push(c))
    const lifecycle = (type: string) => {
      const event = new Event(type)
      Object.defineProperty(event, 'persisted', { value: true })
      s.surface.window.dispatchEvent(event)
    }
    try {
      await tick()
      await s.trusted.set('settings.theme', 'dark')
      await tick()
      expect(events).toHaveLength(1)
      lifecycle('pagehide')
      await tick()
      await s.trusted.set('settings.theme', 'light')
      await tick()
      expect(events).toHaveLength(1)
      lifecycle('pageshow')
      await tick()
      await tick()
      expect(events).toEqual([
        { key: 'settings.theme', oldValue: undefined, newValue: 'dark' },
        { key: 'settings.theme', oldValue: 'dark', newValue: 'light' },
      ])
      await s.trusted.remove('settings.theme')
      await tick()
      expect(events).toHaveLength(3)
    } finally {
      stop()
      await tick()
      await s.finish()
    }
  })
  test('exposure unsubscribe is idempotent across replacement registrations', async () => {
    const s = pageSetup()
    try {
      s.stopExpose()
      const replacement = s.content
        .namespace('settings')
        .exposeToPage(s.bridge, {
          read: ['theme'],
          write: ['theme'],
          validate: {
            theme: (v): v is 'dark' | 'light' => v === 'dark' || v === 'light',
          },
        })
      s.stopExpose()
      const another = s.content.namespace('settings').exposeToPage(s.bridge, {
        read: ['language'],
        validate: { language: (v): v is string => typeof v === 'string' },
      })
      await s.page.set('settings.theme', 'dark')
      expect(await s.page.get('settings.theme')).toBe('dark')
      another()
      replacement()
    } finally {
      await s.finish()
    }
  })
  test('exposure rejects missing validators, write-only watch, overlap and fake bridges', async () => {
    const s = pageSetup()
    try {
      expect(() =>
        expose(s.csRuntime, 'local', 'settings', s.bridge, {
          read: ['secret'],
          validate: {},
        })
      ).toThrow()
      expect(() =>
        expose(s.csRuntime, 'local', 'settings', s.bridge, {
          watch: ['secret'],
          validate: { secret: (v): v is string => typeof v === 'string' },
        })
      ).toThrow()
      expect(() =>
        expose(s.csRuntime, 'local', 'settings', s.bridge, {
          read: ['theme'],
          validate: { theme: (v): v is string => typeof v === 'string' },
        })
      ).toThrow()
      expect(() =>
        expose(
          s.csRuntime,
          'local',
          'settings',
          { dispose() {} } as PageBridge,
          { validate: {} }
        )
      ).toThrow()
    } finally {
      await s.finish()
    }
  })
})
