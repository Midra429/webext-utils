import type { Unsubscribe } from '../internal/types'
import type { Port } from './port'
import type { Endpoint, Reply, Request } from './protocol'
import type { MessageSender, SendOptions } from './types'

import { object } from '../internal/browser'
import { WebextError, nativeError } from '../internal/errors'
import { assertJson } from '../internal/json'
import { Environment } from './environment'
import { observe, port } from './port'
import {
  DEFAULT_TIMEOUT,
  PORT,
  deadline,
  envelope,
  fail,
  failure,
  isMissing,
  name,
  reply,
  request,
  success,
  target,
  wire,
} from './protocol'
import { Router } from './router'

type Handler = (
  data: unknown,
  sender: MessageSender,
  request: Request
) => unknown
interface Registration {
  owner: object
  handler: Handler
  pending: Set<(error: WebextError) => void>
}
export class MessageHub {
  private handlers = new Map<string, Registration>()
  private instanceId = ''
  private generation = 0
  private router: Router | undefined
  private connection: Port | undefined
  private endpoint: Endpoint | undefined
  private removePort: (() => void) | undefined
  private removeControl: (() => void) | undefined
  private controls = new Map<
    string,
    { resolve(value: unknown): void; reject(error: unknown): void }
  >()
  private registration: Promise<void> = Promise.resolve()
  private registrationError: unknown
  private registrationObservers = new Set<(error: unknown) => void>()
  private disconnectObservers = new Set<(sender: MessageSender) => void>()
  private updating: Promise<void> | undefined
  private pendingConnections = new Set<
    (error: ReturnType<typeof fail>) => void
  >()
  constructor(
    private env = new Environment(),
    private pageProxy = false
  ) {}
  observeRegistrationErrors(callback: (error: unknown) => void): Unsubscribe {
    this.registrationObservers.add(callback)
    return () => {
      this.registrationObservers.delete(callback)
    }
  }
  observeDisconnects(callback: (sender: MessageSender) => void): Unsubscribe {
    this.disconnectObservers.add(callback)
    return () => {
      this.disconnectObservers.delete(callback)
    }
  }

  pageHub(): MessageHub {
    const context = this.env.context.get()
    if (context.kind !== 'content-script' || context.world !== 'ISOLATED')
      throw fail(
        'CONTEXT_UNAVAILABLE',
        'ブリッジは ISOLATED world の Content Script でのみ設置できます'
      )
    return new MessageHub(this.env, true)
  }

  startBackground(): Unsubscribe {
    if (this.router)
      throw fail(
        'INVALID_ARGUMENT',
        'Background のルーターはすでに起動しています'
      )
    if (this.env.context.get().kind !== 'background')
      throw fail(
        'CONTEXT_UNAVAILABLE',
        'startBackground() は Background で呼び出してください'
      )
    const router = new Router(
      this.env,
      (r, s) => this.dispatch(r, s),
      (sender) => {
        for (const callback of this.disconnectObservers) {
          try {
            callback(sender)
          } catch {
            /* Independent lifecycle observers. */
          }
        }
      }
    )
    try {
      router.start()
    } catch (error) {
      router.stop()
      throw error
    }
    this.router = router
    return () => {
      if (this.router === router) {
        this.router = undefined
        router.stop()
        for (const cancel of this.pendingConnections)
          cancel(fail('TRANSPORT_CLOSED', 'ルーターが停止しました'))
      }
    }
  }
  on(
    owner: object,
    key: string,
    handler: Handler,
    internal = false
  ): Unsubscribe {
    name(key, internal)
    if (typeof handler !== 'function')
      throw fail('INVALID_ARGUMENT', 'ハンドラーには関数を指定してください')
    if (this.handlers.has(key))
      throw fail(
        'INVALID_ARGUMENT',
        'この実行環境では、このメッセージ名のハンドラーがすでに登録されています'
      )
    const context = this.env.context.get()
    if (context.kind === 'unknown')
      throw fail(
        'CONTEXT_UNAVAILABLE',
        '実行場所を特定できないため、ハンドラーを登録できません'
      )
    if (context.kind === 'content-script' && context.world === 'MAIN')
      throw fail('UNSUPPORTED_OPERATION', 'MAIN world ではブリッジが必要です')
    this.instanceId ||= crypto.randomUUID()
    const registration = {
      owner,
      handler,
      pending: new Set<(error: WebextError) => void>(),
    }
    this.handlers.set(key, registration)
    try {
      if (context.kind !== 'background') this.ensureControl()
    } catch (error) {
      this.handlers.delete(key)
      throw error
    }
    this.schedule()
    let active = true
    return () => {
      if (!active) return
      active = false
      if (this.handlers.get(key) === registration) {
        for (const cancel of registration.pending)
          cancel(fail('TRANSPORT_CLOSED', 'ハンドラーの登録が解除されました'))
        this.handlers.delete(key)
        this.schedule()
      }
    }
  }
  dispose(owner: object): void {
    let changed = false
    for (const [key, registration] of this.handlers)
      if (registration.owner === owner) {
        for (const cancel of registration.pending)
          cancel(fail('TRANSPORT_CLOSED', '受信側が破棄されました'))
        this.handlers.delete(key)
        changed = true
      }
    if (changed) this.schedule()
  }
  private schedule(): void {
    // Attach rejection handling immediately; ready/send observes registration errors.
    const previous = this.registration
    this.registration = (async () => {
      try {
        await previous
      } catch {
        /* A later explicit update can recover. */
      }
      this.registrationError = undefined
      try {
        await this.update(Date.now() + DEFAULT_TIMEOUT)
      } catch (error) {
        this.registrationError = error
        throw error
      }
    })()
    void this.registration.catch(() => {})
  }
  async ready(until = Date.now() + DEFAULT_TIMEOUT): Promise<void> {
    if (this.env.context.get().kind === 'unknown')
      throw fail('CONTEXT_UNAVAILABLE', 'messaging の実行場所を特定できません')
    try {
      let snapshot: Promise<void>
      do {
        snapshot = this.registration
        await deadline(snapshot, until)
      } while (snapshot !== this.registration)
      if (this.updating) await deadline(this.updating, until)
    } catch (error) {
      if (Date.now() >= until) throw error
    }
    if (
      this.handlers.size &&
      this.env.context.get().kind === 'background' &&
      !this.router
    )
      throw fail(
        'ROUTER_UNAVAILABLE',
        'Background のルーターが起動していません'
      )
    if (
      this.registrationError ||
      (this.handlers.size && !this.router && !this.connection)
    ) {
      let last: unknown
      for (const delay of [0, 25, 100]) {
        if (delay)
          await deadline(
            new Promise((resolve) => setTimeout(resolve, delay)),
            until
          )
        try {
          await this.update(until)
          this.registrationError = undefined
          return
        } catch (error) {
          last = error
        }
      }
      throw last
    }
  }
  private ensureControl(): void {
    if (this.removeControl) return
    this.removeControl = this.env.listen(
      ['runtime', 'onMessage'],
      (value, nativeSender, respond) => {
        const v = object(value)
        if (
          v?.protocol !== wire('').protocol ||
          v.type !== 'reconnect' ||
          v.instanceId !== this.instanceId ||
          !this.handlers.size
        )
          return
        if (typeof respond !== 'function') return
        void (async () => {
          const id = typeof v.id === 'string' ? v.id : ''
          try {
            envelope(value)
            this.env.sender(nativeSender)
            if (
              !id ||
              typeof v.deadline !== 'number' ||
              v.deadline <= Date.now()
            )
              throw fail('VALIDATION_ERROR', '再接続の制御メッセージが不正です')
            await this.ready(v.deadline)
            respond(success(id, undefined))
          } catch (error) {
            respond(failure(id, error))
          }
        })()
        return true
      }
    )
  }
  private connect(): Port {
    if (this.connection) return this.connection
    const connect = this.env.method('runtime', 'connect')
    if (!connect)
      throw fail('CONTEXT_UNAVAILABLE', 'runtime.connect がありません')
    const p = port(connect({ name: PORT }))
    this.connection = p
    this.removePort = observe(
      p,
      (value) => {
        void this.portMessage(p, value)
      },
      () => {
        this.env.value('runtime', 'lastError')
        if (this.connection !== p) return
        this.removePort?.()
        this.removePort = undefined
        this.connection = undefined
        for (const pending of this.controls.values())
          pending.reject(
            fail('TRANSPORT_CLOSED', '登録用の Port が切断されました')
          )
        this.controls.clear()
        for (const cancel of this.pendingConnections)
          cancel(fail('TRANSPORT_CLOSED', '受信用の Port が切断されました'))
        // Keep only the passive reconnect listener. No idle retries or heartbeat.
      }
    )
    return p
  }
  private async portMessage(p: Port, value: unknown): Promise<void> {
    const id =
      typeof object(value)?.id === 'string' ? String(object(value)?.id) : ''
    try {
      const v = envelope(value)
      if (!v || !id) return
      if (v.type === 'reply') {
        const pending = this.controls.get(id)
        if (pending) {
          this.controls.delete(id)
          pending.resolve(value)
        }
        return
      }
      if (
        v.type !== 'deliver' ||
        v.instanceId !== this.instanceId ||
        this.connection !== p
      )
        throw fail('VALIDATION_ERROR', '配信メッセージが不正です')
      const r = request(v.request)
      const from = object(v.sender)
      if (
        !from ||
        typeof from.id !== 'string' ||
        !['extension', 'page'].includes(String(from.trust)) ||
        !['background', 'content-script', 'extension-page'].includes(
          String(from.context)
        )
      )
        throw fail('VALIDATION_ERROR', 'ブラウザの送信元情報が不正です')
      const response = await this.dispatch(r, from as unknown as MessageSender)
      if (!response.ok && response.error.code === 'NO_RECEIVER')
        throw fail(
          'TRANSPORT_CLOSED',
          '選択した受信ハンドラーは解除されています'
        )
      const result = reply(response, r.id)
      if (this.connection === p && r.deadline > Date.now())
        p.postMessage(success(id, result))
    } catch (error) {
      if (id && this.connection === p) {
        try {
          p.postMessage(failure(id, error))
        } catch {
          /* Port owner handles disconnect. */
        }
      }
    }
  }
  private async update(until: number): Promise<void> {
    if (this.updating) return await deadline(this.updating, until)
    const updating = this.performUpdate(until)
    this.updating = updating
    try {
      await updating
    } finally {
      if (this.updating === updating) this.updating = undefined
    }
  }
  private async performUpdate(until: number): Promise<void> {
    const context = this.env.context.get()
    if (context.kind === 'background') return
    if (!this.handlers.size && !this.connection && !this.endpoint) {
      this.removeControl?.()
      this.removeControl = undefined
      return
    }
    if (!this.endpoint) {
      const info = await deadline(this.env.context.resolve(), until)
      if (info.kind === 'unknown' || info.kind === 'background')
        throw fail('CONTEXT_UNAVAILABLE', '受信側の実行場所を特定できません')
      if (info.kind === 'content-script' && info.world === 'MAIN')
        throw fail('UNSUPPORTED_OPERATION', 'MAIN world ではブリッジが必要です')
      this.endpoint = {
        instanceId: this.instanceId,
        generation: 0,
        names: [],
        context: info.kind,
        ...(info.kind === 'content-script'
          ? {
              world: this.pageProxy ? ('MAIN' as const) : ('ISOLATED' as const),
            }
          : {}),
      }
    }
    const p = this.connect()
    const id = crypto.randomUUID()
    const endpoint = {
      ...this.endpoint,
      generation: ++this.generation,
      names: [...this.handlers.keys()],
    }
    try {
      const ack = await deadline(
        new Promise<unknown>((resolve, reject) => {
          this.controls.set(id, { resolve, reject })
          try {
            p.postMessage(
              wire(endpoint.names.length ? 'register' : 'unregister', {
                id,
                endpoint,
              })
            )
          } catch (error) {
            reject(nativeError('messaging.register', error))
          }
        }),
        until
      )
      reply(ack, id)
      if (!endpoint.names.length && !this.handlers.size) this.release()
    } catch (error) {
      if (this.connection === p) {
        this.connection = undefined
        this.removePort?.()
        this.removePort = undefined
        p.disconnect()
      }
      if (!this.handlers.size) {
        this.removeControl?.()
        this.removeControl = undefined
      }
      for (const callback of this.registrationObservers) {
        try {
          callback(error)
        } catch {
          /* Independent observers. */
        }
      }
      throw error
    } finally {
      this.controls.delete(id)
    }
  }
  private release(): void {
    const p = this.connection
    this.connection = undefined
    this.removePort?.()
    this.removePort = undefined
    this.removeControl?.()
    this.removeControl = undefined
    this.endpoint = undefined
    p?.disconnect()
  }
  async internalInstance(): Promise<string> {
    await this.ready()
    if (!this.endpoint)
      throw fail('CONTEXT_UNAVAILABLE', '受信用のエンドポイントがありません')
    return this.instanceId
  }
  async dispatch(r: Request, from: MessageSender): Promise<Reply> {
    try {
      if (r.deadline <= Date.now())
        throw fail('TIMEOUT', '要求の期限が切れました')
      const registered = this.handlers.get(r.name)
      if (!registered)
        throw fail('NO_RECEIVER', 'ハンドラーが登録されていません')
      const invoke = async () => {
        try {
          return await registered.handler(r.data, from, r)
        } catch (cause) {
          if (
            (this.pageProxy || r.name.startsWith('__webext_utils')) &&
            cause instanceof WebextError
          )
            throw cause
          throw new WebextError(
            'HANDLER_ERROR',
            'messaging.handler',
            '受信ハンドラーで例外が発生しました',
            { cause }
          )
        }
      }
      const value = await deadline(
        invoke(),
        r.deadline,
        this.pendingConnections,
        registered.pending
      )
      if (r.mode !== 'send' && value !== undefined)
        throw fail('HANDLER_ERROR', '通知の受信ハンドラーは値を返せません')
      return success(r.id, value)
    } catch (error) {
      return failure(r.id, error)
    }
  }
  async send(
    key: string,
    data: unknown,
    options: SendOptions,
    mode: Request['mode'],
    cancellations: Set<(error: ReturnType<typeof fail>) => void>,
    page = false,
    internal = false
  ): Promise<unknown> {
    name(key, internal)
    assertJson(data, 'messaging.send', true)
    const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2147483647)
      throw fail(
        'INVALID_ARGUMENT',
        'timeoutMs にはタイマーで使える正の有限値を指定してください'
      )
    if (
      options.ignoreMissing !== undefined &&
      typeof options.ignoreMissing !== 'boolean'
    )
      throw fail(
        'INVALID_ARGUMENT',
        'ignoreMissing には真偽値を指定してください'
      )
    if (mode === 'all' && !options.target)
      throw fail(
        'INVALID_ARGUMENT',
        'notifyAll() では target を明示してください'
      )
    const to = target(options.target ?? { context: 'background' })
    const context = this.env.context.get()
    if (context.kind === 'unknown')
      throw fail('CONTEXT_UNAVAILABLE', 'messaging の実行場所を特定できません')
    if (context.kind === 'content-script' && context.world === 'MAIN')
      throw fail('UNSUPPORTED_OPERATION', 'MAIN world ではブリッジが必要です')
    const r: Request = {
      ...wire('request'),
      type: 'request',
      id: crypto.randomUUID(),
      deadline: Date.now() + timeout,
      name: key,
      target: to,
      mode,
      ...(page ? { page: true } : {}),
      ...(data === undefined ? {} : { data }),
    } as Request
    const execute = async () => {
      if (this.handlers.size) await this.ready(r.deadline)
      if (this.router)
        return reply(await this.router.route(r, this.env.ownSender()), r.id)
      if (context.kind === 'background')
        throw fail(
          'ROUTER_UNAVAILABLE',
          'Background のルーターが起動していません'
        )
      const send = this.env.method('runtime', 'sendMessage')
      if (!send)
        throw fail('CONTEXT_UNAVAILABLE', 'runtime.sendMessage を使えません')
      let result: unknown
      try {
        result = await send(r)
      } catch (cause) {
        if (isMissing(cause))
          throw fail(
            'ROUTER_UNAVAILABLE',
            'Background のルーターが待ち受けていません'
          )
        throw nativeError('runtime.sendMessage', cause)
      }
      if (result === undefined)
        throw fail(
          'ROUTER_UNAVAILABLE',
          'Background のルーターが待ち受けていません'
        )
      return reply(result, r.id)
    }
    try {
      const value = await deadline(execute(), r.deadline, cancellations)
      return options.ignoreMissing ? { delivered: true, value } : value
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
}

let shared: MessageHub | undefined

/** Returns the hub shared by every messaging client in this JavaScript realm. */
export function currentHub(): MessageHub {
  return (shared ??= new MessageHub())
}
