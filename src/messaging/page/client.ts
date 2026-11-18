import type { Unsubscribe } from '../../internal/types'
import type { MessageSender, MessagingClient, SendOptions } from '../types'

import { object } from '../../internal/browser'
import { assertJson } from '../../internal/json'
import { DEFAULT_TIMEOUT, deadline, fail, name, target } from '../protocol'
import { PagePeer } from './peer'
import { serviceClients } from './services'
import { PageEnvironment, channel, encode } from './wire'

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
  private constructor(channel: string, page: PageEnvironment) {
    super(channel, page, false)
    this.session = crypto.randomUUID()
    this.attach()
  }
  static create<O>(
    key: string,
    page = new PageEnvironment()
  ): MessagingClient<O> {
    channel(key)
    const channels = clients.get(page.document) ?? new Map<string, PageClient>()
    clients.set(page.document, channels)
    let shared = channels.get(key)
    if (!shared || shared.stopped) {
      shared = new PageClient(key, page)
      channels.set(key, shared)
    }
    return shared.client<O>()
  }
  private client<O>(): MessagingClient<O> {
    const owner = {}
    this.owners.add(owner)
    let disposed = false
    const cancellations = new Set<(error: ReturnType<typeof fail>) => void>()
    const active = () => {
      if (disposed || this.stopped || this.suspended)
        throw fail('TRANSPORT_CLOSED', 'ページのクライアントは閉じています')
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
        throw fail('INVALID_ARGUMENT', 'ページからの送信オプションが不正です')
      if (options.target) target(options.target)
      encode({ data: data === undefined ? null : data })
      // Validate before initiating a handshake or dispatch.
      const started = Date.now()
      try {
        return await deadline(
          (async () => {
            await this.ready()
            active()
            if (Date.now() >= started + timeout)
              throw fail('TIMEOUT', 'ページからの送信が期限を過ぎました')
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
        throw fail('ACCESS_DENIED', 'ページからの一斉送信は許可されていません')
      },
      installPageBridge: () => {
        throw fail('ACCESS_DENIED', 'MAIN world ではブリッジを設置できません')
      },
      on: (key: string, handler: Handler): Unsubscribe => {
        active()
        name(key)
        if (typeof handler !== 'function')
          throw fail('INVALID_ARGUMENT', 'ハンドラーには関数を指定してください')
        const registered =
          names.get(this.page.document) ?? new Map<string, object>()
        names.set(this.page.document, registered)
        if (registered.has(key))
          throw fail(
            'INVALID_ARGUMENT',
            'この実行環境では、このメッセージ名のハンドラーがすでに登録されています'
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
              cancel(
                fail(
                  'TRANSPORT_CLOSED',
                  'ページのハンドラー登録が解除されました'
                )
              )
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
          cancel(
            fail('TRANSPORT_CLOSED', 'ページのクライアントが破棄されました')
          )
        cancellations.clear()
        this.owners.delete(owner)
        for (const [key, entry] of this.handlers)
          if (entry.owner === owner) {
            for (const cancel of entry.pending)
              cancel(fail('TRANSPORT_CLOSED', 'ページの受信側が破棄されました'))
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
        encode({ data })
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
      throw fail('TRANSPORT_CLOSED', 'ブリッジは閉じています')
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
      if (this.inFlight.has(id))
        throw fail('VALIDATION_ERROR', 'ページへの要求 ID が重複しています')
      this.inFlight.add(id)
      name(v.name)
      const entry = this.handlers.get(v.name)
      if (!entry)
        throw fail('NO_RECEIVER', 'ページにハンドラーが登録されていません')
      const sender = object(v.sender)
      if (
        !sender ||
        typeof sender.id !== 'string' ||
        !['extension', 'page'].includes(String(sender.trust)) ||
        !['background', 'content-script', 'extension-page'].includes(
          String(sender.context)
        )
      )
        throw fail('VALIDATION_ERROR', 'ページへの要求の送信元情報が不正です')
      const timeout = v.timeoutMs ?? DEFAULT_TIMEOUT
      if (
        typeof timeout !== 'number' ||
        !Number.isFinite(timeout) ||
        timeout <= 0 ||
        timeout > 2147483647
      )
        throw fail('VALIDATION_ERROR', 'ページへの要求のタイムアウトが不正です')
      const value = await deadline(
        Promise.resolve().then(async () => {
          try {
            return await entry.handler(
              v.data,
              sender as unknown as MessageSender
            )
          } catch {
            throw fail(
              'HANDLER_ERROR',
              'ページのハンドラーで例外が発生しました'
            )
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
