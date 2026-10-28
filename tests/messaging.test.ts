import { afterEach, describe, expect, test } from 'bun:test'

import { WebextError } from '../src/internal/errors'
import { assertJson } from '../src/internal/json'
import {
  PROTOCOL,
  RECORD_PREFIX,
  deadline,
  envelope,
  request,
  target,
  wire,
} from '../src/messaging/protocol'
import { Realm } from '../src/messaging/realm'
import { NativeBus } from './helpers/messaging-native'

const cleanup: (() => void)[] = []
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) stop()
  await tick()
})
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))
function setup() {
  const bus = new NativeBus()
  const bg = new Realm(bus.realm('background').env)
  const stop = bg.startBackground()
  cleanup.push(stop)
  const make = (
    kind: Parameters<NativeBus['realm']>[0] = 'extension-page',
    meta: Record<string, unknown> = {}
  ) => {
    const native = bus.realm(kind, meta)
    const realm = new Realm(native.env)
    const owner = {}
    cleanup.push(() => realm.dispose(owner))
    return {
      realm,
      owner,
      native,
      on: (key: string, handler: (data: unknown, sender: unknown) => unknown) =>
        realm.on(owner, key, handler),
      send: (
        key: string,
        data?: unknown,
        options: Parameters<Realm['send']>[2] = {}
      ) => realm.send(key, data, options, 'send', new Set()),
    }
  }
  const sender = make()
  return { bus, bg, make, sender, stop }
}
const view = { context: 'extension-page' as const }

describe('JSON and protocol boundaries', () => {
  test('accepts JSON and omitted top-level values', () => {
    for (const value of [null, true, 1, '日本語', [], { a: [1, { b: false }] }])
      assertJson(value)
    assertJson(undefined, 'test', true)
  })
  test('rejects non JSON values, accessors, holes, symbols and limits', () => {
    const cycle: unknown[] = []
    cycle.push(cycle)
    const getter = {
      get value() {
        throw Error('must not execute')
      },
    }
    let nested: unknown = 0
    for (let i = 0; i < 66; i++) nested = { nested }
    for (const value of [
      undefined,
      NaN,
      Infinity,
      1n,
      () => {},
      new Date(),
      new Map(),
      new Set(),
      cycle,
      [, 1],
      { a: undefined },
      getter,
      { [Symbol()]: 1 },
      nested,
      'x'.repeat(1048577),
    ])
      expect(() => assertJson(value)).toThrow(WebextError)
  })
  test('rejects invalid targets and preserves AND selectors', () => {
    for (const v of [
      { context: 'background', tabId: 1 },
      { context: 'content-script' },
      { context: 'content-script', tabId: -1 },
      { context: 'popup', frameId: 0 },
      { context: 'popup', instanceId: '' },
      { context: 'bad' },
    ])
      expect(() => target(v)).toThrow()
    expect(
      target({
        context: 'content-script',
        tabId: 1,
        frameId: 0,
        documentId: 'doc',
      })
    ).toMatchObject({ documentId: 'doc' })
  })
  test('rejects malformed protocol and accepts unrelated messages silently', () => {
    expect(envelope({ hello: 'world' })).toBeUndefined()
    expect(() =>
      envelope({ protocol: PROTOCOL, version: 2, type: 'request' })
    ).toThrow()
    expect(() => request(wire('request', { id: 'x', deadline: NaN }))).toThrow()
  })
})

describe('request routing and errors', () => {
  test('background uses sendMessage, no Port/storage, and native sender', async () => {
    const { bus, bg, sender } = setup()
    bus.storageError = Error('storage unavailable')
    bg.on({}, 'sum', (value, from) => {
      expect(from.id).toBe('test-extension')
      return Number(value) + 1
    })
    expect(await sender.send('sum', 2)).toBe(3)
    expect(bus.connects).toBe(0)
    expect(await bg.send('sum', 4, {}, 'send', new Set())).toBe(5)
  })
  test('100 concurrent requests retain correlation and reverse completion order', async () => {
    const { make, sender } = setup()
    const receiver = make()
    receiver.on('echo', async (value) => {
      await new Promise((resolve) => setTimeout(resolve, 100 - Number(value)))
      return value
    })
    await receiver.realm.ready()
    expect(
      await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          sender.send('echo', i, { target: view })
        )
      )
    ).toEqual(Array.from({ length: 100 }, (_, i) => i))
  })
  test('more than one receiver fails before handlers run; instance selector resolves it', async () => {
    const { make, sender, bus } = setup()
    let calls = 0
    for (let i = 0; i < 2; i++) {
      const r = make()
      r.on('work', () => ++calls)
      await r.realm.ready()
    }
    await expect(
      sender.send('work', undefined, { target: view })
    ).rejects.toMatchObject({ code: 'AMBIGUOUS_TARGET' })
    expect(calls).toBe(0)
    const id = String(
      (Object.values(bus.records)[0] as { instanceId: string }).instanceId
    )
    expect(
      await sender.send('work', undefined, {
        target: { ...view, instanceId: id },
      })
    ).toBe(1)
  })
  test('content defaults to frame 0 and honors document and native sender identity', async () => {
    const { make, sender } = setup()
    const top = make('content-script', {
      tab: { id: 9, windowId: 3 },
      frameId: 0,
      documentId: 'top',
    })
    const iframe = make('content-script', {
      tab: { id: 9, windowId: 3 },
      frameId: 2,
      documentId: 'child',
    })
    top.on('title', () => 'top')
    iframe.on('title', () => 'child')
    await Promise.all([top.realm.ready(), iframe.realm.ready()])
    expect(
      await sender.send('title', undefined, {
        target: { context: 'content-script', tabId: 9 },
      })
    ).toBe('top')
    expect(
      await sender.send('title', undefined, {
        target: {
          context: 'content-script',
          tabId: 9,
          frameId: 2,
          documentId: 'child',
        },
      })
    ).toBe('child')
    await expect(
      sender.send('title', undefined, {
        target: {
          context: 'content-script',
          tabId: 9,
          frameId: 2,
          documentId: 'top',
        },
      })
    ).rejects.toMatchObject({ code: 'NO_RECEIVER' })
  })
  test('ignoreMissing suppresses only verified absence, including normal void success', async () => {
    const { bg, sender } = setup()
    expect(
      await sender.send('absent', undefined, { ignoreMissing: true })
    ).toEqual({ delivered: false })
    bg.on({}, 'void', () => {})
    expect(
      await sender.send('void', undefined, { ignoreMissing: true })
    ).toEqual({ delivered: true, value: undefined })
    bg.on({}, 'error', () => {
      throw Error('secret')
    })
    await expect(
      sender.send('error', undefined, { ignoreMissing: true })
    ).rejects.toMatchObject({ code: 'HANDLER_ERROR' })
    bg.on({}, 'reject', async () => {
      throw Error('rejected')
    })
    await expect(sender.send('reject')).rejects.toMatchObject({
      code: 'HANDLER_ERROR',
    })
    bg.on({}, 'hang', () => new Promise(() => {}))
    await expect(
      sender.send('hang', undefined, { timeoutMs: 10, ignoreMissing: true })
    ).rejects.toMatchObject({ code: 'TIMEOUT' })
  })
  test('missing router, native failures and unsupported MAIN are not absence', async () => {
    const { bus, sender, stop } = setup()
    stop()
    await expect(
      sender.send('x', undefined, { ignoreMissing: true })
    ).rejects.toMatchObject({ code: 'ROUTER_UNAVAILABLE' })
    bus.requestError = Error('permission denied by native')
    await expect(
      sender.send('x', undefined, { ignoreMissing: true })
    ).rejects.toMatchObject({ code: 'NATIVE_ERROR', cause: bus.requestError })
  })
  test('non JSON handler response is SERIALIZATION_ERROR', async () => {
    const { bg, sender } = setup()
    bg.on({}, 'bad', () => new Date())
    await expect(sender.send('bad')).rejects.toMatchObject({
      code: 'SERIALIZATION_ERROR',
    })
  })
  test('duplicate names across factories within a realm fail synchronously', async () => {
    const { make } = setup()
    const receiver = make()
    const stop = receiver.on('x', () => 1)
    expect(() => receiver.realm.on({}, 'x', () => 2)).toThrow(WebextError)
    stop()
    stop()
    receiver.on('x', () => 3)
    await receiver.realm.ready()
  })
  test('unrelated messages have no response; foreign sender cannot dispatch', async () => {
    const { bus, bg } = setup()
    let calls = 0
    bg.on({}, 'x', () => ++calls)
    const cb = [...bus.background!.onMessage.listeners][0]!
    expect(
      cb({ foo: 1 }, { id: 'other' }, () => {
        throw Error('unexpected')
      })
    ).toBeUndefined()
    let received: unknown
    expect(
      cb(
        wire('request', {
          id: '1',
          name: 'x',
          target: { context: 'background' },
          mode: 'send',
          deadline: Date.now() + 100,
        }),
        { id: 'other' },
        (v: unknown) => {
          received = v
        }
      )
    ).toBe(true)
    await tick()
    expect(received).toMatchObject({
      ok: false,
      error: { code: 'ACCESS_DENIED' },
    })
    expect(calls).toBe(0)
  })
  test('notification ACK awaits completion; notifyAll reports partial failures and all frames', async () => {
    const { make, sender } = setup()
    let completed = false
    const a = make('content-script', {
      tab: { id: 1 },
      frameId: 0,
      documentId: 'a',
    })
    const b = make('content-script', {
      tab: { id: 1 },
      frameId: 2,
      documentId: 'b',
    })
    a.on('notice', async () => {
      await tick()
      completed = true
    })
    b.on('notice', () => {
      throw Error('failed')
    })
    await Promise.all([a.realm.ready(), b.realm.ready()])
    const options = { target: { context: 'content-script' as const, tabId: 1 } }
    await sender.realm.send('notice', undefined, options, 'notify', new Set())
    expect(completed).toBe(true)
    const report = (await sender.realm.send(
      'notice',
      undefined,
      options,
      'all',
      new Set()
    )) as { results: { delivered: boolean; error?: { code: string } }[] }
    expect(report.results).toHaveLength(2)
    expect(report.results.filter((r) => r.delivered)).toHaveLength(1)
    expect(report.results.find((r) => !r.delivered)?.error?.code).toBe(
      'HANDLER_ERROR'
    )
  })
})

describe('lifetime and restart recovery', () => {
  test('one shared Port; unsubscribe removes session records, Port and native listener', async () => {
    const { make, bus } = setup()
    const r = make()
    const a = r.on('a', () => 1)
    const b = r.on('b', () => 2)
    await r.realm.ready()
    expect(bus.activePorts()).toBe(1)
    expect(r.native.onMessage.listeners.size).toBe(1)
    a()
    await r.realm.ready()
    expect(bus.activePorts()).toBe(1)
    b()
    await r.realm.ready()
    expect(bus.activePorts()).toBe(0)
    expect(r.native.onMessage.listeners.size).toBe(0)
    expect(Object.keys(bus.records)).toHaveLength(0)
  })
  test('idle disconnect never reconnects; a fresh router probes saved identity and restores subscriptions', async () => {
    const { make, bus, sender, stop, bg } = setup()
    const r = make()
    let calls = 0
    r.on('x', () => ++calls)
    await r.realm.ready()
    const connects = bus.connects
    stop()
    await tick()
    expect(bus.connects).toBe(connects)
    expect(Object.keys(bus.records)).toHaveLength(1)
    cleanup.push(bg.startBackground())
    expect(await sender.send('x', undefined, { target: view })).toBe(1)
    expect(bus.connects).toBe(connects + 1)
    expect(bus.probes).toHaveLength(1)
    expect(
      bus.sends.filter((v) => (v as { name: string }).name === 'x')
    ).toHaveLength(1)
  })
  test('explicit ready reconnects and content recovery probes documentId only', async () => {
    const { make, bus, sender } = setup()
    const r = make('content-script', {
      tab: { id: 7 },
      frameId: 0,
      documentId: 'doc',
    })
    r.on('x', () => 7)
    await r.realm.ready()
    bus.disconnect()
    await tick()
    await r.realm.ready()
    expect(bus.activePorts()).toBe(1)
    bus.disconnect()
    expect(
      await sender.send('x', undefined, {
        target: { context: 'content-script', tabId: 7, documentId: 'doc' },
      })
    ).toBe(7)
  })
  test('inflight receiver disconnect is TRANSPORT_CLOSED and is not replayed', async () => {
    const { make, bus, sender } = setup()
    const r = make()
    let calls = 0
    r.on('hang', () => {
      calls++
      return new Promise(() => {})
    })
    await r.realm.ready()
    const pending = sender.send('hang', undefined, {
      target: view,
      ignoreMissing: true,
      timeoutMs: 1000,
    })
    await tick()
    bus.disconnect()
    await expect(pending).rejects.toMatchObject({ code: 'TRANSPORT_CLOSED' })
    expect(calls).toBe(1)
  })
  test('sender disposal cancellation frees its waiting request', async () => {
    const { bg, sender } = setup()
    bg.on({}, 'hang', () => new Promise(() => {}))
    const cancellations = new Set<(e: WebextError) => void>()
    const pending = sender.realm.send(
      'hang',
      undefined,
      { timeoutMs: 100 },
      'send',
      cancellations
    )
    for (const cancel of cancellations)
      cancel(new WebextError('TRANSPORT_CLOSED', 'dispose', 'disposed'))
    await expect(pending).rejects.toMatchObject({ code: 'TRANSPORT_CLOSED' })
    expect(cancellations.size).toBe(0)
  })
  test('stale candidates are removed; permission/timeouts are propagated instead of NO_RECEIVER', async () => {
    const { bus, sender } = setup()
    bus.records[`${RECORD_PREFIX}gone`] = {
      instanceId: 'gone',
      context: 'extension-page',
      names: ['x'],
      generation: 1,
    }
    await expect(
      sender.send('x', undefined, { target: view })
    ).rejects.toMatchObject({ code: 'NO_RECEIVER' })
    expect(Object.keys(bus.records)).toHaveLength(0)
    const fresh = setup()
    fresh.bus.storageError = Error('denied')
    await expect(
      fresh.sender.send('x', undefined, { target: view, ignoreMissing: true })
    ).rejects.toMatchObject({ code: 'NATIVE_ERROR' })
    const hanging = setup()
    hanging.bus.records[`${RECORD_PREFIX}sleep`] = {
      instanceId: 'sleep',
      context: 'extension-page',
      names: ['x'],
      generation: 1,
    }
    hanging.bus.hangingProbe = true
    await expect(
      hanging.sender.send('x', undefined, {
        target: view,
        ignoreMissing: true,
        timeoutMs: 20,
      })
    ).rejects.toMatchObject({ code: 'TIMEOUT' })
  })
  test('late reply after timeout does not corrupt a subsequent request', async () => {
    const { make, sender } = setup()
    const r = make()
    r.on('x', async (value) => {
      if (value === 1) await new Promise((resolve) => setTimeout(resolve, 30))
      return value
    })
    await r.realm.ready()
    await expect(
      sender.send('x', 1, { target: view, timeoutMs: 10 })
    ).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(await sender.send('x', 2, { target: view })).toBe(2)
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(await sender.send('x', 3, { target: view })).toBe(3)
  })
  test('deadline cancellation removes tracking on success/error', async () => {
    const pending = new Set<(e: WebextError) => void>()
    expect(await deadline(Promise.resolve(1), Date.now() + 100, pending)).toBe(
      1
    )
    expect(pending.size).toBe(0)
    await expect(
      deadline(Promise.reject(Error('fail')), Date.now() + 100, pending)
    ).rejects.toThrow('fail')
    expect(pending.size).toBe(0)
  })
})

describe('registration races and validation', () => {
  test('concurrent ready after disconnect waits for one saved registration', async () => {
    const { bus, make, sender } = setup()
    const r = make()
    r.on('x', () => 1)
    await r.realm.ready()
    bus.disconnect()
    await Promise.all(Array.from({ length: 20 }, () => r.realm.ready()))
    expect(bus.activePorts()).toBe(1)
    expect(await sender.send('x', undefined, { target: view })).toBe(1)
  })
  test('unsubscribe after idle disconnect removes the persisted identity', async () => {
    const { bus, make } = setup()
    const r = make()
    const stop = r.on('x', () => 1)
    await r.realm.ready()
    bus.disconnect()
    stop()
    await r.realm.ready()
    expect(Object.keys(bus.records)).toHaveLength(0)
    expect(bus.activePorts()).toBe(0)
    expect(r.native.onMessage.listeners.size).toBe(0)
  })
  test('new handlers registered while ready awaits are included', async () => {
    const { make, sender } = setup()
    const r = make()
    r.on('one', () => 1)
    const ready = r.realm.ready()
    r.on('two', () => 2)
    await ready
    expect(await sender.send('two', undefined, { target: view })).toBe(2)
  })
  test('handler-thrown WebextErrors remain HANDLER_ERROR', async () => {
    const { bg, sender } = setup()
    bg.on({}, 'x', () => {
      throw new WebextError('NO_RECEIVER', 'handler', 'user error')
    })
    await expect(
      sender.send('x', undefined, { ignoreMissing: true })
    ).rejects.toMatchObject({ code: 'HANDLER_ERROR' })
  })
  test('window filters use native getContexts identity', async () => {
    const { bus, make, sender } = setup()
    const r = make('popup', { documentId: 'popup', tab: { windowId: 8 } })
    r.on('x', () => 1)
    await r.realm.ready()
    expect(Object.values(bus.records)[0]).toMatchObject({ windowId: 8 })
    expect(
      await sender.send('x', undefined, {
        target: { context: 'popup', windowId: 8 },
      })
    ).toBe(1)
    await expect(
      sender.send('x', undefined, { target: { context: 'popup', windowId: 9 } })
    ).rejects.toMatchObject({ code: 'NO_RECEIVER' })
  })
  test('notifyAll background returns a per-endpoint ACK report', async () => {
    const { bg, sender } = setup()
    bg.on({}, 'notice', () => {})
    expect(
      await sender.realm.send(
        'notice',
        undefined,
        { target: { context: 'background' } },
        'all',
        new Set()
      )
    ).toEqual({ results: [{ instanceId: 'background', delivered: true }] })
  })
  test('missing MAIN receiver and invalid options fail safely', async () => {
    const { bus, sender } = setup()
    await expect(
      sender.send('x', undefined, {
        target: { context: 'content-script', tabId: 1, world: 'MAIN' },
        ignoreMissing: true,
      })
    ).resolves.toEqual({ delivered: false })
    const sent = bus.sends.length
    for (const timeoutMs of [0, -1, Infinity, NaN, 2147483648])
      await expect(
        sender.send('x', undefined, { timeoutMs })
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(sender.send('x', new Date())).rejects.toMatchObject({
      code: 'SERIALIZATION_ERROR',
    })
    expect(bus.sends.length).toBe(sent)
  })
  test('view registration without storage fails and cleans the failed Port', async () => {
    const { bus, make } = setup()
    const r = make()
    delete bus.background!.api.storage
    r.on('x', () => 1)
    await expect(r.realm.ready()).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    })
    expect(bus.activePorts()).toBe(0)
    r.realm.dispose(r.owner)
    await expect(r.realm.ready()).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    })
    expect(r.native.onMessage.listeners.size).toBe(0)
  })
})

test('malformed native response is rejected and cannot masquerade as absence', async () => {
  const { bus, sender } = setup()
  bus.background!.onMessage.addListener((value, _from, respond) => {
    const v = value as { id: string }
    ;(respond as (v: unknown) => void)({
      ...wire('reply'),
      id: v.id,
      version: 2,
      ok: true,
    })
  })
  await expect(
    sender.send('x', undefined, { ignoreMissing: true })
  ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
})

test('unsubscription of an executing handler closes the request without replay', async () => {
  const { make, sender } = setup()
  const r = make()
  let calls = 0
  const stop = r.on('x', () => {
    calls++
    return new Promise(() => {})
  })
  await r.realm.ready()
  const pending = sender.send('x', undefined, {
    target: view,
    timeoutMs: 1000,
    ignoreMissing: true,
  })
  await tick()
  stop()
  await expect(pending).rejects.toMatchObject({ code: 'TRANSPORT_CLOSED' })
  await r.realm.ready()
  expect(calls).toBe(1)
})

test('strictly identified deleted-tab candidates are removed without suppressing other native failures', async () => {
  const { bus, sender } = setup()
  bus.records[`${RECORD_PREFIX}gone-tab`] = {
    instanceId: 'gone-tab',
    context: 'content-script',
    tabId: 99,
    frameId: 0,
    documentId: 'old-doc',
    world: 'ISOLATED',
    names: ['x'],
    generation: 1,
  }
  const tabs = bus.background!.api.tabs as {
    sendMessage: () => Promise<unknown>
  }
  tabs.sendMessage = async () => {
    throw Error('No tab with id: 99.')
  }
  await expect(
    sender.send('x', undefined, {
      target: { context: 'content-script', tabId: 99 },
      ignoreMissing: true,
    })
  ).resolves.toEqual({ delivered: false })
  expect(Object.keys(bus.records)).toHaveLength(0)
})

describe('window routing after a real native membership change', () => {
  for (const kind of ['extension-page', 'options'] as const) {
    test(`${kind}: old window is rejected, AND selectors and restart use the new window`, async () => {
      const { make, sender, bus, bg, stop } = setup()
      const receiver = make(kind, {
        tab: { id: 7, windowId: 2 },
        frameId: 0,
        documentId: 'moving-doc',
      })
      let calls = 0
      receiver.on('where', () => {
        calls++
        return 9
      })
      await receiver.realm.ready()
      const saved = Object.values(bus.records)[0] as { instanceId: string }
      const target = {
        context: kind,
        tabId: 7,
        documentId: 'moving-doc',
        instanceId: saved.instanceId,
      }
      expect(
        await sender.send('where', undefined, {
          target: { ...target, windowId: 2 },
        })
      ).toBe(9)
      receiver.native.nativeSender.tab = { id: 7, windowId: 9 }
      await expect(
        sender.send('where', undefined, { target: { ...target, windowId: 2 } })
      ).rejects.toMatchObject({ code: 'NO_RECEIVER' })
      expect(calls).toBe(1)
      expect(
        await sender.send('where', undefined, {
          target: { ...target, windowId: 9 },
        })
      ).toBe(9)
      for (const mismatch of [
        { tabId: 8 },
        { documentId: 'other-doc' },
        { instanceId: 'other-instance' },
      ])
        await expect(
          sender.send('where', undefined, {
            target: { ...target, windowId: 9, ...mismatch },
          })
        ).rejects.toMatchObject({ code: 'NO_RECEIVER' })
      // Persist the original stale snapshot, then force a fresh router restore.
      for (const key of Object.keys(bus.records))
        (bus.records[key] as { windowId: number }).windowId = 2
      stop()
      cleanup.push(bg.startBackground())
      await expect(
        sender.send('where', undefined, { target: { ...target, windowId: 2 } })
      ).rejects.toMatchObject({ code: 'NO_RECEIVER' })
      expect(
        await sender.send('where', undefined, {
          target: { ...target, windowId: 9 },
        })
      ).toBe(9)
      expect(Object.values(bus.records)[0]).toMatchObject({ windowId: 9 })
      expect(calls).toBe(3)
    })
  }
})
