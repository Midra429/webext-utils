import type { Unsubscribe } from '../internal/errors'
import type { Port } from './port'
import type { Endpoint, Reply, Request } from './protocol'
import type { MessageSender, SendOptions } from './types'

import { WebextError, nativeError } from '../internal/errors'
import { assertJson } from '../internal/json'
import { object } from '../internal/native'
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
export class Realm {
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

  pageRealm(): Realm {
    const context = this.env.context.get()
    if (context.kind !== 'content-script' || context.world !== 'ISOLATED')
      throw fail('CONTEXT_UNAVAILABLE', 'Page bridges require ISOLATED context')
    return new Realm(this.env, true)
  }

  startBackground(): Unsubscribe {
    if (this.router)
      throw fail('INVALID_ARGUMENT', 'Background router already started')
    if (this.env.context.get().kind !== 'background')
      throw fail(
        'CONTEXT_UNAVAILABLE',
        'startBackground requires Background context'
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
          cancel(fail('TRANSPORT_CLOSED', 'Router stopped'))
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
      throw fail('INVALID_ARGUMENT', 'Handler must be a function')
    if (this.handlers.has(key))
      throw fail('INVALID_ARGUMENT', 'Handler already registered in this realm')
    const context = this.env.context.get()
    if (context.kind === 'unknown')
      throw fail(
        'CONTEXT_UNAVAILABLE',
        'Cannot register handler in unknown context'
      )
    if (context.kind === 'content-script' && context.world === 'MAIN')
      throw fail('UNSUPPORTED_OPERATION', 'MAIN requires a bridge')
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
          cancel(fail('TRANSPORT_CLOSED', 'Subscription removed'))
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
          cancel(fail('TRANSPORT_CLOSED', 'Receiver disposed'))
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
      throw fail('CONTEXT_UNAVAILABLE', 'Messaging context unavailable')
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
      throw fail('ROUTER_UNAVAILABLE', 'Background router not started')
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
              throw fail('VALIDATION_ERROR', 'Invalid reconnect control')
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
    if (!connect) throw fail('CONTEXT_UNAVAILABLE', 'No runtime.connect')
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
            fail('TRANSPORT_CLOSED', 'Registration port disconnected')
          )
        this.controls.clear()
        for (const cancel of this.pendingConnections)
          cancel(fail('TRANSPORT_CLOSED', 'Receiver port disconnected'))
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
        throw fail('VALIDATION_ERROR', 'Invalid delivery')
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
        throw fail('VALIDATION_ERROR', 'Invalid native sender metadata')
      const response = await this.dispatch(r, from as unknown as MessageSender)
      if (!response.ok && response.error.code === 'NO_RECEIVER')
        throw fail('TRANSPORT_CLOSED', 'Selected subscription was removed')
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
        throw fail('CONTEXT_UNAVAILABLE', 'Cannot identify receiving context')
      if (info.kind === 'content-script' && info.world === 'MAIN')
        throw fail('UNSUPPORTED_OPERATION', 'MAIN requires a bridge')
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
      throw fail('CONTEXT_UNAVAILABLE', 'No receiving endpoint')
    return this.instanceId
  }
  async dispatch(r: Request, from: MessageSender): Promise<Reply> {
    try {
      if (r.deadline <= Date.now()) throw fail('TIMEOUT', 'Request expired')
      const registered = this.handlers.get(r.name)
      if (!registered) throw fail('NO_RECEIVER', 'No handler registered')
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
            'Message handler failed',
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
        throw fail('HANDLER_ERROR', 'Notification handler must return no value')
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
        'timeoutMs must be a positive finite timer duration'
      )
    if (
      options.ignoreMissing !== undefined &&
      typeof options.ignoreMissing !== 'boolean'
    )
      throw fail('INVALID_ARGUMENT', 'ignoreMissing must be boolean')
    if (mode === 'all' && !options.target)
      throw fail('INVALID_ARGUMENT', 'notifyAll requires explicit target')
    const to = target(options.target ?? { context: 'background' })
    const context = this.env.context.get()
    if (context.kind === 'unknown')
      throw fail('CONTEXT_UNAVAILABLE', 'Messaging context unavailable')
    if (context.kind === 'content-script' && context.world === 'MAIN')
      throw fail('UNSUPPORTED_OPERATION', 'MAIN requires a bridge')
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
        throw fail('ROUTER_UNAVAILABLE', 'Background router not started')
      const send = this.env.method('runtime', 'sendMessage')
      if (!send)
        throw fail('CONTEXT_UNAVAILABLE', 'runtime.sendMessage unavailable')
      let result: unknown
      try {
        result = await send(r)
      } catch (cause) {
        if (isMissing(cause))
          throw fail('ROUTER_UNAVAILABLE', 'Background router is not listening')
        throw nativeError('runtime.sendMessage', cause)
      }
      if (result === undefined)
        throw fail('ROUTER_UNAVAILABLE', 'Background router is not listening')
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
