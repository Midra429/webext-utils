import type { Unsubscribe } from '../internal/errors'
import type {
  MessageSender,
  MessagingClient,
  PageBridgeLimits,
  SendOptions,
} from './types'

import { assertJson } from '../internal/json'
import { object } from '../internal/native'
import { PagePeer } from './page-peer'
import { serviceClients } from './page-services'
import { PageEnvironment, channel, encode, limits } from './page-wire'
import { DEFAULT_TIMEOUT, deadline, fail, name, target } from './protocol'

type Handler = (data: unknown, sender: MessageSender) => unknown
const clients = new WeakMap<object, Map<string, PageClient>>()
const names = new WeakMap<object, Map<string, object>>()
export class PageClient extends PagePeer {
  private handlers = new Map<
    string,
    {
      owner: object
      handler: Handler
      pending: Set<(error: ReturnType<typeof fail>) => void>
    }
  >()
  private owners = new Set<object>()
  private connecting: Promise<void> | undefined
  private revision = 0
  private accepted = -1
  private inFlight = new Set<string>()
  private serviceListeners = new Map<
    object,
    { name: string; callback: (value: unknown) => void }
  >()
  private reconnectListeners = new Set<() => void>()
  private constructor(
    channel: string,
    page: PageEnvironment,
    settings?: PageBridgeLimits
  ) {
    super(channel, page, limits(settings), false)
    this.session = crypto.randomUUID()
    this.attach()
  }
  static create<O>(
    key: string,
    page = new PageEnvironment(),
    settings?: PageBridgeLimits
  ): MessagingClient<O> {
    channel(key)
    const channels = clients.get(page.document) ?? new Map<string, PageClient>()
    clients.set(page.document, channels)
    let shared = channels.get(key)
    if (!shared || shared.stopped) {
      shared = new PageClient(key, page, settings)
      channels.set(key, shared)
    }
    if (
      settings &&
      JSON.stringify(limits(settings)) !== JSON.stringify(shared.bound)
    )
      throw fail('INVALID_ARGUMENT', 'Shared page channel limits must match')
    return shared.client<O>()
  }
  private client<O>(): MessagingClient<O> {
    const owner = {}
    this.owners.add(owner)
    let disposed = false
    const cancellations = new Set<(error: ReturnType<typeof fail>) => void>()
    const active = () => {
      if (disposed || this.stopped || this.suspended)
        throw fail('TRANSPORT_CLOSED', 'Page client closed')
    }
    const send = async (
      key: string,
      data: unknown,
      options: SendOptions = {},
      mode = 'send'
    ) => {
      active()
      name(key)
      assertJson(data, 'page.send', true)
      const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT
      if (
        !Number.isFinite(timeout) ||
        timeout <= 0 ||
        timeout > 2147483647 ||
        (options.ignoreMissing !== undefined &&
          typeof options.ignoreMissing !== 'boolean')
      )
        throw fail('INVALID_ARGUMENT', 'Invalid page send options')
      if (options.target) target(options.target)
      encode({ data: data === undefined ? null : data }, this.bound)
      // Validate and bound before initiating a handshake or dispatch.
      const started = Date.now()
      try {
        return await deadline(
          (async () => {
            await this.ready()
            active()
            if (Date.now() >= started + timeout)
              throw fail('TIMEOUT', 'Page send deadline exceeded')
            const value = this.result(
              await this.exchange(
                'request',
                {
                  name: key,
                  mode,
                  timeoutMs: Math.max(1, timeout - (Date.now() - started)),
                  ...(data === undefined ? {} : { data }),
                  ...(options.target ? { target: options.target } : {}),
                },
                Math.max(1, timeout - (Date.now() - started)),
                cancellations
              )
            )
            return options.ignoreMissing ? { delivered: true, value } : value
          })(),
          started + timeout,
          cancellations
        )
      } catch (error) {
        if (
          options.ignoreMissing &&
          error instanceof Error &&
          'code' in error &&
          error.code === 'NO_RECEIVER'
        )
          return { delivered: false }
        throw error
      }
    }
    const client = {
      send: (key: string, data?: unknown, options?: SendOptions) =>
        send(key, data, options),
      notify: (key: string, data?: unknown, options?: SendOptions) =>
        send(key, data, options, 'notify'),
      notifyAll: async () => {
        active()
        throw fail('ACCESS_DENIED', 'Page broadcast is not allowed')
      },
      installPageBridge: () => {
        throw fail('ACCESS_DENIED', 'MAIN cannot install a privileged bridge')
      },
      on: (key: string, handler: Handler): Unsubscribe => {
        active()
        name(key)
        if (typeof handler !== 'function')
          throw fail('INVALID_ARGUMENT', 'Invalid page handler')
        const registered =
          names.get(this.page.document) ?? new Map<string, object>()
        names.set(this.page.document, registered)
        if (registered.has(key))
          throw fail(
            'INVALID_ARGUMENT',
            'Handler already registered in this realm'
          )
        registered.set(key, owner)
        this.handlers.set(key, { owner, handler, pending: new Set() })
        this.revision++
        queueMicrotask(() => {
          if (!disposed && !this.stopped) void this.ready().catch(() => {})
        })
        let subscribed = true
        return () => {
          if (!subscribed) return
          subscribed = false
          if (this.handlers.get(key)?.owner === owner) {
            for (const cancel of this.handlers.get(key)!.pending)
              cancel(fail('TRANSPORT_CLOSED', 'Page subscription removed'))
            this.handlers.delete(key)
            registered.delete(key)
            this.revision++
            if (!this.stopped && !this.suspended)
              void this.ready().catch(() => {})
          }
        }
      },
      ready: async () => {
        active()
        await deadline(
          this.ready(),
          Date.now() + DEFAULT_TIMEOUT,
          cancellations
        )
      },
      dispose: () => {
        if (disposed) return
        disposed = true
        for (const cancel of cancellations)
          cancel(fail('TRANSPORT_CLOSED', 'Page client disposed'))
        cancellations.clear()
        this.owners.delete(owner)
        for (const [key, entry] of this.handlers)
          if (entry.owner === owner) {
            for (const cancel of entry.pending)
              cancel(fail('TRANSPORT_CLOSED', 'Page receiver disposed'))
            this.handlers.delete(key)
            names.get(this.page.document)?.delete(key)
            this.revision++
          }
        if (!this.owners.size) this.dispose()
        else if (!this.stopped && !this.suspended)
          void this.ready().catch(() => {})
      },
    } as unknown as MessagingClient<O>
    serviceClients.set(client, {
      request: async (name, data) => {
        active()
        assertJson(data, 'page.service')
        encode({ data }, this.bound)
        await this.ready()
        active()
        return this.result(
          await this.exchange(
            'service',
            { name, data },
            DEFAULT_TIMEOUT,
            cancellations
          )
        )
      },
      listen: (name, callback) => {
        active()
        const token = {}
        this.serviceListeners.set(token, { name, callback })
        return () => {
          this.serviceListeners.delete(token)
        }
      },
      reconnect: (callback) => {
        this.reconnectListeners.add(callback)
        return () => {
          this.reconnectListeners.delete(callback)
        }
      },
      dispose: () => client.dispose(),
    })
    return client
  }
  async ready(): Promise<void> {
    if (this.stopped || this.suspended)
      throw fail('TRANSPORT_CLOSED', 'Page bridge closed')
    if (this.connecting) await this.connecting
    if (this.accepted === this.revision) return
    const revision = this.revision
    const connect = async () => {
      for (const wait of [250, 1000, 8750]) {
        try {
          this.result(
            await this.exchange(
              'hello',
              { names: [...this.handlers.keys()] },
              wait
            )
          )
          this.accepted = revision
          return
        } catch (error) {
          if (
            !(
              error instanceof Error &&
              'code' in error &&
              error.code === 'TIMEOUT'
            ) ||
            wait === 8750
          )
            throw error
        }
      }
    }
    const task = connect()
    this.connecting = task
    try {
      await task
    } finally {
      if (this.connecting === task) this.connecting = undefined
    }
    if (this.accepted !== this.revision) await this.ready()
  }
  protected override load(): number {
    return this.pending.size + this.inFlight.size
  }
  protected async handle(v: Record<string, unknown>): Promise<void> {
    if (v.session !== this.session) return
    if (v.type === 'close') {
      this.reset()
      this.accepted = -1
      for (const callback of this.reconnectListeners) callback()
      return
    }
    if (v.type === 'service-event') {
      for (const listener of this.serviceListeners.values())
        if (listener.name === v.name) {
          try {
            listener.callback(v.data)
          } catch {
            /* Observer owns its errors. */
          }
        }
      return
    }
    if (v.type !== 'request') return
    const id = String(v.id),
      epoch = this.epoch
    try {
      if (this.inFlight.has(id) || this.load() >= this.bound.maxPending)
        throw fail('QUOTA_EXCEEDED', 'Page receiver busy')
      this.inFlight.add(id)
      name(v.name)
      const entry = this.handlers.get(v.name)
      if (!entry) throw fail('NO_RECEIVER', 'No page handler')
      const sender = object(v.sender)
      if (
        !sender ||
        typeof sender.id !== 'string' ||
        !['extension', 'page'].includes(String(sender.trust)) ||
        !['background', 'content-script', 'extension-page'].includes(
          String(sender.context)
        )
      )
        throw fail('VALIDATION_ERROR', 'Invalid page sender')
      const timeout = v.timeoutMs ?? DEFAULT_TIMEOUT
      if (
        typeof timeout !== 'number' ||
        !Number.isFinite(timeout) ||
        timeout <= 0 ||
        timeout > 2147483647
      )
        throw fail('VALIDATION_ERROR', 'Invalid page request timeout')
      const value = await deadline(
        Promise.resolve().then(async () => {
          try {
            return await entry.handler(
              v.data,
              sender as unknown as MessageSender
            )
          } catch {
            throw fail('HANDLER_ERROR', 'Page handler failed')
          }
        }),
        Date.now() + timeout,
        this.cancellations,
        entry.pending
      )
      if (
        epoch === this.epoch &&
        this.handlers.get(v.name) === entry &&
        !this.stopped &&
        !this.suspended
      )
        this.respond(id, value)
    } catch (error) {
      if (epoch === this.epoch && !this.stopped && !this.suspended)
        this.reject(id, error)
    } finally {
      this.inFlight.delete(id)
    }
  }
  protected suspend(): void {
    try {
      if (!this.suspended) this.emit('close', crypto.randomUUID())
    } catch {
      /* Teardown. */
    }
    this.accepted = -1
    this.connecting = undefined
    this.session = crypto.randomUUID()
    this.inFlight.clear()
  }
  protected resume(): void {
    void this.ready().catch(() => {})
    for (const callback of this.reconnectListeners) callback()
  }
  override dispose(): void {
    if (this.stopped) return
    super.dispose()
    for (const key of this.handlers.keys())
      names.get(this.page.document)?.delete(key)
    this.handlers.clear()
    this.serviceListeners.clear()
    this.reconnectListeners.clear()
    clients.get(this.page.document)?.delete(this.channel)
  }
}
