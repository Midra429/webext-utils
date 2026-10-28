import type { RuntimePolicy } from '../src/messaging/page-bridge'
import type { MessageSender, MessageTarget } from '../src/messaging/types'

import { describe, expect, test } from 'bun:test'

import { IsolatedBridge } from '../src/messaging/page-bridge'
import { PageClient } from '../src/messaging/page-client'
import {
  PAGE_PROTOCOL,
  PageEnvironment,
  eventName,
} from '../src/messaging/page-wire'
import { Realm } from '../src/messaging/realm'
import { NativeBus } from './helpers/messaging-native'

class Surface extends PageEnvironment {
  override document = new EventTarget() as unknown as Document
  override window = new EventTarget() as unknown as Window & typeof globalThis
  actual = 'https://example.com'
  url = 'https://example.com/page'
  packets: { type: string; value: Record<string, unknown> }[] = []
  override origin() {
    return this.actual
  }
  override href() {
    return this.url
  }
  override emit(type: string, detail: string) {
    this.packets.push({ type, value: JSON.parse(detail) })
    this.document.dispatchEvent(new CustomEvent(type, { detail }))
  }
  raw(value: unknown, raw?: unknown) {
    this.document.dispatchEvent(
      new CustomEvent(eventName('public', true), {
        detail: raw ?? JSON.stringify(value),
      })
    )
  }
  lifecycle(type: string, persisted: boolean) {
    const event = new Event(type)
    Object.defineProperty(event, 'persisted', { value: persisted })
    this.window.dispatchEvent(event)
  }
}
type Messages = {
  echo: { data: number; response: number }
  title: { data: void; response: string }
  nothing: { data: void; response: void }
  denied: { data: void; response: void }
}
const number = (v: unknown): v is number => typeof v === 'number'
const string = (v: unknown): v is string => typeof v === 'string'
const none = (v: unknown): v is void => v === undefined
function policy(): RuntimePolicy {
  return {
    channel: 'public',
    allowedOrigins: ['https://example.com:443/path'],
    fromPage: {
      echo: {
        target: { context: 'background' },
        validateData: number,
        validateResponse: number,
      },
      nothing: {
        target: { context: 'background' },
        validateData: none,
        validateResponse: none,
      },
    },
    toPage: { title: { validateData: none, validateResponse: string } },
  }
}
function setup(
  options = policy(),
  mainLimits?: import('../src/messaging/types').PageBridgeLimits
) {
  const bus = new NativeBus()
  const bg = new Realm(bus.realm('background').env)
  const stop = bg.startBackground()
  const isolated = bus.realm('content-script', {
    tab: { id: 7, windowId: 2 },
    frameId: 0,
    documentId: 'doc',
    url: 'https://example.com/page',
  })
  const realm = new Realm(isolated.env)
  const page = new Surface()
  const bridge = new IsolatedBridge(realm, options, page)
  const main = PageClient.create<Messages>('public', page, mainLimits)
  const owners: object[] = []
  function on(
    key: string,
    handler: (data: unknown, sender: MessageSender) => unknown
  ) {
    const owner = {}
    owners.push(owner)
    return bg.on(owner, key, handler)
  }
  async function cleanup() {
    main.dispose()
    bridge.dispose()
    for (const owner of owners) bg.dispose(owner)
    await realm.ready()
    await new Promise((r) => setTimeout(r, 5))
    stop()
  }
  return { bus, bg, realm, page, bridge, main, on, cleanup, isolated }
}
const mainTarget = {
  context: 'content-script' as const,
  world: 'MAIN' as const,
  tabId: 7,
}
function packet(
  id: string,
  session: string,
  extra: Record<string, unknown> = {}
) {
  return {
    protocol: PAGE_PROTOCOL,
    version: 1,
    direction: 'from-page',
    type: 'request',
    id,
    session,
    name: 'echo',
    mode: 'send',
    data: 1,
    ...extra,
  }
}
const tick = () => new Promise((r) => setTimeout(r, 10))

describe('MAIN bridge', () => {
  test('bidirectional routing, native page trust, notifications and cleanup', async () => {
    const s = setup()
    let sender: MessageSender | undefined
    s.on('echo', (data, from) => {
      sender = from
      return data
    })
    s.on('nothing', () => {})
    const off = s.main.on('title', () => 'page title')
    try {
      await s.main.ready()
      expect(await s.main.send('echo', 42)).toBe(42)
      expect(sender).toMatchObject({
        trust: 'page',
        context: 'content-script',
        tabId: 7,
        frameId: 0,
        documentId: 'doc',
        id: 'test-extension',
      })
      await s.main.notify('nothing')
      expect(
        await s.bg.send(
          'title',
          undefined,
          { target: mainTarget },
          'send',
          new Set()
        )
      ).toBe('page title')
      const view = new Realm(s.bus.realm('popup', { documentId: 'view' }).env)
      expect(
        await view.send(
          'title',
          undefined,
          { target: mainTarget },
          'send',
          new Set()
        )
      ).toBe('page title')
      expect(
        await s.realm.send(
          'title',
          undefined,
          { target: mainTarget },
          'send',
          new Set()
        )
      ).toBe('page title')
      expect(
        Object.values(s.bus.records).some(
          (v) => (v as { world?: string }).world === 'MAIN'
        )
      ).toBe(true)
      off()
      await tick()
      await expect(
        s.bg.send('title', undefined, { target: mainTarget }, 'send', new Set())
      ).rejects.toMatchObject({ code: 'NO_RECEIVER' })
    } finally {
      await s.cleanup()
    }
    expect(s.isolated.onMessage.listeners.size).toBe(0)
    expect(s.bus.ports.every((p) => p.closed)).toBe(true)
    expect(Object.keys(s.bus.records)).toHaveLength(0)
  })

  test('parallel out of order responses correlate correctly', async () => {
    const s = setup(
      {
        ...policy(),
        limits: { maxPending: 128, requestsPerMinute: 150 },
      },
      { maxPending: 128 }
    )
    s.on('echo', async (v) => {
      await new Promise((r) => setTimeout(r, (100 - Number(v)) % 10))
      return v
    })
    try {
      const values = await Promise.all(
        Array.from({ length: 100 }, (_, i) => s.main.send('echo', i))
      )
      expect(values).toEqual(Array.from({ length: 100 }, (_, i) => i))
    } finally {
      await s.cleanup()
    }
  })

  test('policy denies unknown/internal names, target escalation, forged sender and broadcast', async () => {
    const s = setup()
    let calls = 0
    s.on('echo', (v) => {
      calls++
      return v
    })
    try {
      await s.main.ready()
      await expect(s.main.send('denied')).rejects.toMatchObject({
        code: 'ACCESS_DENIED',
      })
      await expect(
        s.main.send('echo', 1, { target: { context: 'popup' } })
      ).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
      await expect(
        s.main.notifyAll('nothing', undefined, {
          target: { context: 'background' },
        })
      ).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
      const session = String(
        s.page.packets.find((p) => p.value.type === 'hello')!.value.session
      )
      s.page.raw(
        packet('forged', session, { sender: { id: 'fake', tabId: 100 } })
      )
      s.page.raw(packet('internal', session, { name: '__webext_utils_secret' }))
      s.page.raw(
        packet('field', session, {
          origin: 'https://example.com',
          execute: 'tabs',
        })
      )
      await tick()
      expect(calls).toBe(0)
      expect(
        await s.main.send('echo', 2, { target: { context: 'background' } })
      ).toBe(2)
    } finally {
      await s.cleanup()
    }
  })

  test('both validators, void validation, safe errors and response validation', async () => {
    const s = setup()
    s.on('echo', () => 'wrong')
    s.on('nothing', () => {})
    try {
      await expect(s.main.send('echo', 2)).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      })
      await expect(s.main.send('nothing', 123 as never)).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      })
      s.main.on('title', () => 123 as never)
      await s.main.ready()
      await expect(
        s.bg.send('title', undefined, { target: mainTarget }, 'send', new Set())
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    } finally {
      await s.cleanup()
    }
    const errors = setup()
    errors.on('echo', () => {
      throw Error('secret-token')
    })
    try {
      await expect(
        errors.main.send('echo', 2, { ignoreMissing: true })
      ).rejects.toMatchObject({ code: 'HANDLER_ERROR' })
      expect(JSON.stringify(errors.page.packets)).not.toContain('secret-token')
    } finally {
      await errors.cleanup()
    }
  })

  test('deny opaque, non-http, foreign and changed origins', async () => {
    const bus = new NativeBus()
    const realm = new Realm(bus.realm('content-script').env)
    for (const actual of [
      'null',
      'file:///page',
      'data:text/html,page',
      'https://example.com.attacker.test',
    ]) {
      const page = new Surface()
      page.actual = actual
      expect(() => new IsolatedBridge(realm, policy(), page)).toThrow()
    }
    expect(
      () =>
        new IsolatedBridge(
          new Realm(bus.realm('popup').env),
          policy(),
          new Surface()
        )
    ).toThrow()
    const s = setup()
    let calls = 0
    s.on('echo', (v) => {
      calls++
      return v
    })
    try {
      await s.main.ready()
      s.page.actual = 'https://evil.test'
      await expect(s.main.send('echo', 1)).rejects.toMatchObject({
        code: 'ACCESS_DENIED',
      })
      expect(calls).toBe(0)
    } finally {
      await s.cleanup()
    }
  })

  test('malformed and oversized JSON, UTF8 size, depth and prototype keys are rejected', async () => {
    const s = setup()
    let calls = 0
    s.on('echo', (v) => {
      calls++
      return v
    })
    try {
      await s.main.ready()
      const session = String(s.page.packets[0]!.value.session)
      for (const detail of [
        {},
        '{',
        'x'.repeat(65537),
        JSON.stringify(
          packet('unicode', session, { data: 'あ'.repeat(23000) })
        ),
        '{"__proto__":{"polluted":true}}',
      ])
        s.page.raw({}, detail)
      let deep: unknown = 1
      for (let i = 0; i < 33; i++) deep = { a: deep }
      s.page.raw(packet('depth', session, { data: deep }))
      s.page.raw(packet('version', session, { version: 2 }))
      s.page.raw(
        packet('prototype', session, {
          data: { constructor: { prototype: { polluted: true } } },
        })
      )
      await tick()
      expect(calls).toBe(0)
      expect(await s.main.send('echo', 4)).toBe(4)
    } finally {
      await s.cleanup()
    }
  })

  test('replayed request ID and document rate limit reject before dispatch', async () => {
    const s = setup({ ...policy(), limits: { requestsPerMinute: 4 } })
    let calls = 0
    s.on('echo', (v) => {
      calls++
      return v
    })
    try {
      await s.main.ready()
      const session = String(s.page.packets[0]!.value.session)
      s.page.raw(packet('once', session))
      await tick()
      s.page.raw(packet('once', session))
      await tick()
      expect(calls).toBe(1)
      await s.main.send('echo', 1)
      await s.main.send('echo', 2)
      await expect(s.main.send('echo', 3)).rejects.toMatchObject({
        code: 'QUOTA_EXCEEDED',
      })
      expect(calls).toBe(3)
    } finally {
      await s.cleanup()
    }
  })

  test('pending limit, timeout and late responses release pending entries', async () => {
    const s = setup({ ...policy(), limits: { maxPending: 1 } })
    let finish!: (v: unknown) => void
    s.on(
      'echo',
      () =>
        new Promise((r) => {
          finish = r
        })
    )
    try {
      await s.main.ready()
      const pending = s.main.send('echo', 1, { timeoutMs: 40 })
      await tick()
      await expect(s.main.send('echo', 2)).rejects.toMatchObject({
        code: 'QUOTA_EXCEEDED',
      })
      await expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' })
      finish(1)
      await tick()
      expect(
        (s.bridge as unknown as { pending: Map<string, unknown> }).pending.size
      ).toBe(0)
    } finally {
      await s.cleanup()
    }
  })

  test('shared MAIN subscriptions, duplicate names and final dispose cleanup', async () => {
    const s = setup()
    const other = PageClient.create<Messages>('public', s.page)
    s.main.on('title', () => 'first')
    expect(() => other.on('title', () => 'duplicate')).toThrow()
    try {
      await other.ready()
      s.main.dispose()
      await tick()
      other.on('title', () => 'second')
      await other.ready()
      expect(
        await s.bg.send(
          'title',
          undefined,
          { target: mainTarget },
          'send',
          new Set()
        )
      ).toBe('second')
    } finally {
      other.dispose()
      await s.cleanup()
    }
  })

  test('dispose rejects pending and bridge teardown removes native resources', async () => {
    const s = setup()
    s.on('echo', () => new Promise(() => {}))
    s.main.on('title', () => 'title')
    await s.main.ready()
    const pending = s.main.send('echo', 1)
    void pending.catch(() => {})
    await tick()
    s.bridge.dispose()
    await expect(pending).rejects.toMatchObject({ code: 'TRANSPORT_CLOSED' })
    await expect(
      s.main.send('echo', 1, { timeoutMs: 20 })
    ).rejects.toMatchObject({ code: 'TIMEOUT' })
    await s.cleanup()
    expect(s.isolated.onMessage.listeners.size).toBe(0)
  })

  test('BFCache changes generation, rejects old requests and re-registers handlers', async () => {
    const s = setup()
    s.main.on('title', () => 'restored')
    s.on('echo', () => new Promise(() => {}))
    try {
      await s.main.ready()
      const oldSession = String(s.page.packets[0]!.value.session)
      const pending = s.main.send('echo', 1)
      void pending.catch(() => {})
      await tick()
      s.page.lifecycle('pagehide', true)
      await expect(pending).rejects.toMatchObject({ code: 'TRANSPORT_CLOSED' })
      await tick()
      expect(s.isolated.onMessage.listeners.size).toBe(0)
      s.page.lifecycle('pageshow', true)
      await s.main.ready()
      expect(
        await s.bg.send(
          'title',
          undefined,
          { target: mainTarget },
          'send',
          new Set()
        )
      ).toBe('restored')
      const current = s.page.packets
        .filter((p) => p.value.type === 'hello')
        .at(-1)!.value.session
      expect(current).not.toBe(oldSession)
      s.page.raw(packet('old-generation', oldSession))
      await tick()
      expect(
        s.bus.sends.filter((v) => (v as { name?: string }).name === 'echo')
      ).toHaveLength(1)
    } finally {
      await s.cleanup()
    }
  })
})

// Correlation is intentionally public: a forged reply of the correct type is
// still page data. Validators reject invalid values, not a page impersonator.
test('forged page responses remain untrusted and must pass the response validator', async () => {
  const s = setup()
  s.main.on('title', () => new Promise(() => {}))
  try {
    await s.main.ready()
    for (const [forged, accepted] of [
      [123, false],
      ['page-forged', true],
    ] as const) {
      const pending = s.bg.send(
        'title',
        undefined,
        { target: mainTarget, timeoutMs: 80 },
        'send',
        new Set()
      )
      void pending.catch(() => {})
      await tick()
      const request = s.page.packets
        .filter((p) => p.value.type === 'request' && p.value.name === 'title')
        .at(-1)!.value
      s.page.raw({
        protocol: PAGE_PROTOCOL,
        version: 1,
        direction: 'from-page',
        type: 'reply',
        id: request.id,
        session: request.session,
        ok: true,
        value: forged,
      })
      if (accepted) expect(await pending).toBe('page-forged')
      else
        await expect(pending).rejects.toMatchObject({
          code: 'VALIDATION_ERROR',
        })
    }
  } finally {
    await s.cleanup()
  }
})

test('MAIN proxy recovers after router restart without an idle reconnect', async () => {
  const s = setup()
  s.main.on('title', () => 'after restart')
  try {
    await s.main.ready()
    const connects = s.bus.connects
    // Stop only this test's native Background listeners/ports via its router.
    const router = (s.bg as unknown as { router: { stop(): void } }).router
    router.stop()
    await tick()
    expect(s.bus.connects).toBe(connects)
    const restarted = new Realm(s.bus.background!.env)
    const stop = restarted.startBackground()
    try {
      expect(
        await restarted.send(
          'title',
          undefined,
          { target: mainTarget },
          'send',
          new Set()
        )
      ).toBe('after restart')
      expect(s.bus.probes.length).toBeGreaterThan(0)
    } finally {
      stop()
    }
  } finally {
    await s.cleanup()
  }
})

test('MAIN in-flight unsubscribe closes requests and timeout frees incoming work', async () => {
  const s = setup()
  const stop = s.main.on('title', () => new Promise(() => {}))
  try {
    await s.main.ready()
    const pending = s.bg.send(
      'title',
      undefined,
      { target: mainTarget, timeoutMs: 100 },
      'send',
      new Set()
    )
    void pending.catch(() => {})
    await tick()
    stop()
    await expect(pending).rejects.toMatchObject({ code: 'TRANSPORT_CLOSED' })
    await tick()
    s.main.on('title', () => new Promise(() => {}))
    await s.main.ready()
    await expect(
      s.bg.send(
        'title',
        undefined,
        { target: mainTarget, timeoutMs: 20 },
        'send',
        new Set()
      )
    ).rejects.toMatchObject({ code: 'TIMEOUT' })
    await tick()
    expect(
      (s.bridge as unknown as { pending: Map<string, unknown> }).pending.size
    ).toBe(0)
  } finally {
    await s.cleanup()
  }
})

test('unauthorized handlers, invalid policies and duplicate channels fail closed', async () => {
  const s = setup()
  try {
    expect(() => new IsolatedBridge(s.realm, policy(), s.page)).toThrow()
    s.main.on('denied', () => {})
    await expect(s.main.ready()).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
    })
    expect(Object.keys(s.bus.records)).toHaveLength(0)
    const invalid = {
      ...policy(),
      channel: 'another',
      fromPage: {
        echo: { target: { context: 'background' }, validateData: number },
      },
    }
    expect(
      () =>
        new IsolatedBridge(s.realm, invalid as unknown as RuntimePolicy, s.page)
    ).toThrow()
    for (const value of [0, -1, Infinity, NaN, 1.5])
      expect(
        () =>
          new IsolatedBridge(
            s.realm,
            { ...policy(), limits: { maxPending: value } },
            s.page
          )
      ).toThrow()
  } finally {
    await s.cleanup()
  }
})

test('navigation tears down both worlds and rejects further client use', async () => {
  const s = setup()
  s.main.on('title', () => 'title')
  await s.main.ready()
  s.page.lifecycle('pagehide', false)
  await expect(s.main.ready()).rejects.toMatchObject({
    code: 'TRANSPORT_CLOSED',
  })
  await s.cleanup()
  expect(s.bus.ports.every((p) => p.closed)).toBe(true)
  expect(s.isolated.onMessage.listeners.size).toBe(0)
})

test('8 by 8 routing matrix includes MAIN with fixed policies in both directions', async () => {
  const contexts = [
    'background',
    'content-script',
    'MAIN',
    'popup',
    'side-panel',
    'popout',
    'options',
    'extension-page',
  ] as const
  const targetFor = (context: (typeof contexts)[number]): MessageTarget => {
    if (context === 'MAIN') return mainTarget
    if (context === 'content-script')
      return { context, world: 'ISOLATED', tabId: 7 }
    if (context === 'background') return { context }
    return { context }
  }
  const options = policy()
  for (const context of contexts)
    options.fromPage[`matrix:${context}`] = {
      target: targetFor(context),
      validateData: string,
      validateResponse: string,
    }
  options.toPage['matrix:MAIN'] = {
    validateData: string,
    validateResponse: string,
  }
  const s = setup(options)
  const owner = {}
  const page = PageClient.create<
    Record<string, { data: string; response: string }>
  >('public', s.page)
  const realms = new Map<string, Realm>([
    ['background', s.bg],
    ['content-script', s.realm],
  ])
  const off: (() => void)[] = []
  try {
    for (const context of contexts) {
      if (context === 'MAIN') {
        off.push(
          page.on('matrix:MAIN', (data, sender) => {
            expect(sender.trust).toBe(data === 'MAIN' ? 'page' : 'extension')
            return 'MAIN'
          })
        )
      } else {
        let realm = realms.get(context)
        if (!realm) {
          realm = new Realm(s.bus.realm(context, { documentId: context }).env)
          realms.set(context, realm)
        }
        off.push(
          realm.on(owner, `matrix:${context}`, (data, sender) => {
            expect(sender.trust).toBe(data === 'MAIN' ? 'page' : 'extension')
            return context
          })
        )
      }
    }
    await Promise.all([...realms.values()].map((realm) => realm.ready()))
    await page.ready()
    for (const from of contexts)
      for (const to of contexts) {
        const value =
          from === 'MAIN'
            ? await page.send(`matrix:${to}`, from)
            : await realms
                .get(from)!
                .send(
                  `matrix:${to}`,
                  from,
                  { target: targetFor(to) },
                  'send',
                  new Set()
                )
        expect(value).toBe(to)
      }
  } finally {
    for (const stop of off) stop()
    page.dispose()
    await Promise.all([...realms.values()].map((realm) => realm.ready()))
    await s.cleanup()
  }
})

test('independent documents never share a page transport or borrow frame identity', async () => {
  const s = setup()
  const frame = s.bus.realm('content-script', {
    tab: { id: 7, windowId: 2 },
    frameId: 1,
    documentId: 'iframe',
  })
  const realm = new Realm(frame.env),
    surface = new Surface()
  const bridge = new IsolatedBridge(realm, policy(), surface)
  const page = PageClient.create<Messages>('public', surface)
  s.main.on('title', () => 'top')
  page.on('title', () => 'iframe')
  try {
    await Promise.all([s.main.ready(), page.ready()])
    expect(
      await s.bg.send(
        'title',
        undefined,
        { target: mainTarget },
        'send',
        new Set()
      )
    ).toBe('top')
    expect(
      await s.bg.send(
        'title',
        undefined,
        { target: { ...mainTarget, frameId: 1, documentId: 'iframe' } },
        'send',
        new Set()
      )
    ).toBe('iframe')
    let sender: MessageSender | undefined
    s.on('echo', (v, from) => {
      sender = from
      return v
    })
    expect(await page.send('echo', 1)).toBe(1)
    expect(sender).toMatchObject({
      tabId: 7,
      frameId: 1,
      documentId: 'iframe',
      trust: 'page',
    })
    await expect(
      page.send('echo', 1, { target: mainTarget })
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
  } finally {
    page.dispose()
    bridge.dispose()
    await realm.ready()
    await s.cleanup()
  }
})
