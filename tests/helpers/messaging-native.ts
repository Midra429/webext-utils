import type { ContextInfo } from '../../src/context'
import type { Port } from '../../src/messaging/port'

import { Environment } from '../../src/messaging/environment'

export class Event<T extends (...args: never[]) => unknown> {
  listeners = new Set<T>()
  addListener = (cb: T) => {
    this.listeners.add(cb)
  }
  removeListener = (cb: T) => {
    this.listeners.delete(cb)
  }
}
type Listener = (...args: unknown[]) => unknown
class FakePort implements Port {
  name = '@midra/webext-utils/messaging/1'
  sender: unknown
  onMessage = new Event<(value: unknown) => void>()
  onDisconnect = new Event<() => void>()
  peer!: FakePort
  closed = false
  postMessage(value: unknown): void {
    if (this.closed) throw Error('Port disconnected')
    const clone = structuredClone(value)
    queueMicrotask(() => {
      if (!this.closed)
        for (const cb of this.peer.onMessage.listeners) cb(clone)
    })
  }
  disconnect(): void {
    if (this.closed) return
    this.closed = true
    this.peer.closed = true
    for (const cb of [...this.onDisconnect.listeners]) cb()
    for (const cb of [...this.peer.onDisconnect.listeners]) cb()
  }
}
export class NativeBus {
  records: Record<string, unknown> = {}
  realms: {
    env: Environment
    api: Record<string, unknown>
    onMessage: Event<Listener>
    onConnect: Event<Listener>
    nativeSender: Record<string, unknown>
  }[] = []
  ports: FakePort[] = []
  sends: unknown[] = []
  probes: unknown[] = []
  storageError: unknown
  requestError: unknown
  hangingProbe = false
  connects = 0
  onTabRemoved = new Event<Listener>()
  onTabUpdated = new Event<Listener>()
  background: ReturnType<NativeBus['realm']> | undefined
  realm(
    kind: ContextInfo['kind'] = 'extension-page',
    meta: Record<string, unknown> = {}
  ) {
    const onMessage = new Event<Listener>()
    const onConnect = new Event<Listener>()
    const nativeSender: Record<string, unknown> = {
      id: 'test-extension',
      url:
        kind === 'content-script'
          ? 'https://example.com/'
          : 'chrome-extension://test-extension/view.html',
      ...meta,
    }
    const record = {
      env: new Environment(),
      api: {} as Record<string, unknown>,
      onMessage,
      onConnect,
      nativeSender,
    }
    const send = async (
      value: unknown,
      destinations = this.realms.filter((r) => r !== record)
    ) => {
      const message = value as Record<string, unknown>
      if (message.type === 'request') {
        this.sends.push(value)
        if (this.requestError) throw this.requestError
      }
      if (message.type === 'reconnect') {
        this.probes.push(value)
        if (this.hangingProbe) return await new Promise(() => {})
      }
      let resolve!: (value: unknown) => void
      const response = new Promise((resolveValue) => {
        resolve = resolveValue
      })
      let pending = false
      for (const destination of destinations)
        for (const cb of destination.onMessage.listeners) {
          const result = cb(
            structuredClone(value),
            structuredClone(nativeSender),
            (reply: unknown) => resolve(structuredClone(reply))
          )
          if (result === true) pending = true
        }
      if (!pending)
        throw Error(
          'Could not establish connection. Receiving end does not exist.'
        )
      return await response
    }
    const runtime = {
      id: 'test-extension',
      onMessage,
      onConnect,
      getURL: (path: string) => `chrome-extension://test-extension/${path}`,
      getContexts: async () =>
        this.realms.map((r) => ({
          documentId: r.nativeSender.documentId,
          ...((r.nativeSender.tab ?? {}) as object),
          tabId: (r.nativeSender.tab as { id?: number })?.id,
        })),
      sendMessage: (value: unknown) => send(value),
      connect: () => {
        this.connects++
        const client = new FakePort(),
          server = new FakePort()
        client.peer = server
        server.peer = client
        server.sender = structuredClone(nativeSender)
        this.ports.push(client)
        for (const cb of this.background?.onConnect.listeners ?? []) cb(server)
        if (!this.background?.onConnect.listeners.size)
          queueMicrotask(() => client.disconnect())
        return client
      },
    }
    record.api = {
      runtime,
      storage: {
        session: {
          get: async () => {
            if (this.storageError) throw this.storageError
            return structuredClone(this.records)
          },
          set: async (values: Record<string, unknown>) => {
            if (this.storageError) throw this.storageError
            Object.assign(this.records, structuredClone(values))
          },
          remove: async (key: string) => {
            if (this.storageError) throw this.storageError
            delete this.records[key]
          },
        },
      },
      tabs: {
        onRemoved: this.onTabRemoved,
        onUpdated: this.onTabUpdated,
        get: async (id: number) => {
          const tab = this.realms
            .map((r) => r.nativeSender.tab as { id?: number } | undefined)
            .find((t) => t?.id === id)
          if (!tab) throw Error(`No tab with id: ${id}.`)
          return structuredClone({ windowId: 0, ...tab })
        },
        sendMessage: async (
          tabId: number,
          value: unknown,
          options: { frameId?: number; documentId?: string }
        ) =>
          send(
            value,
            this.realms.filter((r) => {
              const tab = r.nativeSender.tab as { id?: number } | undefined
              return (
                tab?.id === tabId &&
                (options.documentId !== undefined
                  ? r.nativeSender.documentId === options.documentId
                  : r.nativeSender.frameId === options.frameId)
              )
            })
          ),
      },
    }
    record.env.value = (...path) => {
      let value: unknown = record.api
      for (const key of path)
        value = (value as Record<string, unknown> | undefined)?.[key]
      return value
    }
    record.env.method = (...path) => {
      let receiver: unknown = record.api
      for (const key of path.slice(0, -1))
        receiver = (receiver as Record<string, unknown> | undefined)?.[key]
      const method = (receiver as Record<string, unknown> | undefined)?.[
        path.at(-1) ?? ''
      ]
      return typeof method === 'function'
        ? (...args) => method.apply(receiver, args)
        : undefined
    }
    const context = (
      kind === 'background'
        ? { kind, implementation: 'page', source: 'native' }
        : kind === 'content-script'
          ? { kind, world: 'ISOLATED', source: 'native' }
          : { kind, source: 'native' }
    ) as ContextInfo
    record.env.context = { get: () => context, resolve: async () => context }
    this.realms.push(record)
    if (kind === 'background') this.background = record
    return record
  }
  disconnect(): void {
    for (const p of this.ports) p.disconnect()
  }
  activePorts(): number {
    return this.ports.filter((p) => !p.closed).length
  }
}
