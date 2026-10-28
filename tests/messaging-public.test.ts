import { expect, test } from 'bun:test'

import { webextMessaging } from '../src/messaging'
import { NativeBus } from './helpers/messaging-native'

test('public factories share handlers; dispose rejects pending calls and leaves no native listeners', async () => {
  const bus = new NativeBus()
  const bg = bus.realm('background')
  const window = {}
  const original = new Map<string, PropertyDescriptor | undefined>()
  const globals = {
    chrome: bg.api,
    browser: undefined,
    window,
    document: {},
    location: { href: 'chrome-extension://test-extension/bg.html' },
  }
  Object.assign(bg.api, { extension: { getBackgroundPage: () => window } })
  Object.assign(bg.api.runtime as object, {
    getManifest: () => ({ manifest_version: 3 }),
  })
  for (const [key, value] of Object.entries(globals)) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    })
  }
  type Messages = {
    echo: { data: number; response: number }
    hang: { data: void; response: void }
  }
  const a = webextMessaging<Messages>(),
    b = webextMessaging<Messages>()
  let stop: () => void = () => {}
  try {
    stop = webextMessaging.startBackground()
    a.on('echo', (value) => value + 1)
    await a.ready()
    expect(() => b.on('echo', (value) => value)).toThrow()
    expect(await b.send('echo', 3)).toBe(4)
    a.on('hang', () => new Promise(() => {}))
    const pending = b.send('hang', undefined, { timeoutMs: 100 })
    b.dispose()
    b.dispose()
    await expect(pending).rejects.toMatchObject({ code: 'TRANSPORT_CLOSED' })
    await expect(b.send('echo', 3)).rejects.toMatchObject({
      code: 'TRANSPORT_CLOSED',
    })
    expect(() => b.on('echo', (value) => value)).toThrow()
    await expect(b.ready()).rejects.toMatchObject({ code: 'TRANSPORT_CLOSED' })
    a.dispose()
    await webextMessaging<Messages>().ready()
    stop()
    expect(bg.onMessage.listeners.size).toBe(0)
    expect(bg.onConnect.listeners.size).toBe(0)
  } finally {
    a.dispose()
    b.dispose()
    stop()
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
