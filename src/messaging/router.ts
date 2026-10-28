import type { Environment } from './environment'
import type { Port } from './port'
import type { Endpoint, Reply, Request } from './protocol'
import type { MessageSender } from './types'

import { nativeError } from '../internal/errors'
import { object, validId } from '../internal/native'
import { observe, port } from './port'
import {
  PORT,
  RECORD_PREFIX,
  deadline,
  envelope,
  fail,
  failure,
  isMissing,
  matches,
  reply,
  request,
  success,
  wire,
} from './protocol'

interface Connected {
  endpoint: Endpoint
  port: Port
}
interface Pending {
  port: Port
  resolve(value: unknown): void
  reject(error: unknown): void
}
export class Router {
  private endpoints = new Map<string, Connected>()
  private pending = new Map<string, Pending>()
  private ports = new Set<Port>()
  private cleanups = new Set<() => void>()
  private tasks = new Set<(error: ReturnType<typeof fail>) => void>()
  private stopped = false
  // Serializes read/modify/remove with registration and candidate verification.
  private storageQueue: Promise<unknown> = Promise.resolve()
  private restored: Promise<void> | undefined
  constructor(
    private env: Environment,
    private dispatch: (r: Request, sender: MessageSender) => Promise<Reply>,
    private disconnected: (sender: MessageSender) => void = () => {}
  ) {}

  start(): void {
    this.cleanups.add(
      this.env.listen(
        ['runtime', 'onMessage'],
        (value, nativeSender, respond) => {
          if (
            object(value)?.protocol !== wire('').protocol ||
            object(value)?.type !== 'request'
          )
            return
          if (typeof respond !== 'function') return
          void (async () => {
            let id =
              typeof object(value)?.id === 'string'
                ? String(object(value)?.id)
                : ''
            try {
              const r = request(value)
              id = r.id
              const from = this.env.sender(nativeSender)
              respond(await this.route(r, from))
            } catch (error) {
              respond(failure(id, error))
            }
          })()
          return true
        }
      )
    )
    this.cleanups.add(
      this.env.listen(['runtime', 'onConnect'], (value) => {
        if (object(value)?.name !== PORT) return
        const p = port(value)
        try {
          this.env.sender(p.sender)
        } catch {
          p.disconnect()
          return
        }
        this.ports.add(p)
        const cleanup = observe(
          p,
          (v) => {
            void this.portMessage(p, v)
          },
          () => {
            // Reading lastError consumes Chrome's disconnect diagnostic.
            this.env.value('runtime', 'lastError')
            this.restored = undefined
            cleanup()
            this.cleanups.delete(cleanup)
            this.ports.delete(p)
            for (const [id, c] of this.endpoints)
              if (c.port === p) this.endpoints.delete(id)
            for (const [id, pending] of this.pending)
              if (pending.port === p) {
                pending.reject(
                  fail('TRANSPORT_CLOSED', 'Receiver disconnected')
                )
                this.pending.delete(id)
              }
            this.disconnected(this.env.sender(p.sender))
          }
        )
        this.cleanups.add(cleanup)
      })
    )
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.storageQueue
    const task = (async () => {
      try {
        await previous
      } catch {
        /* The failed caller owns its error. */
      }
      return await work()
    })()
    this.storageQueue = task.catch(() => {})
    return task
  }
  private async portMessage(p: Port, value: unknown): Promise<void> {
    const id =
      typeof object(value)?.id === 'string' ? String(object(value)?.id) : ''
    try {
      const v = envelope(value)
      if (!v || !id) throw fail('VALIDATION_ERROR', 'Invalid Port envelope')
      if (v.type === 'reply') {
        const pending = this.pending.get(id)
        if (pending?.port === p) {
          this.pending.delete(id)
          pending.resolve(v)
        }
        return
      }
      if (v.type !== 'register' && v.type !== 'unregister')
        throw fail('VALIDATION_ERROR', 'Unknown Port command')
      const claimed = object(v.endpoint)
      if (
        !claimed ||
        typeof claimed.instanceId !== 'string' ||
        !claimed.instanceId.length ||
        claimed.instanceId.length > 128 ||
        !validId(claimed.generation) ||
        !Array.isArray(claimed.names) ||
        claimed.names.length > 1024 ||
        !claimed.names.every(
          (n) => typeof n === 'string' && n.length > 0 && n.length <= 256
        )
      )
        throw fail('VALIDATION_ERROR', 'Invalid endpoint registration')
      const from = this.env.sender(p.sender)
      // Role labels describe views; only native metadata confers identity.
      const context = claimed.context
      if (
        ![
          'content-script',
          'popup',
          'side-panel',
          'popout',
          'options',
          'extension-page',
          'devtools',
        ].includes(String(context))
      )
        throw fail('VALIDATION_ERROR', 'Invalid endpoint context')
      const e: Endpoint = {
        instanceId: claimed.instanceId,
        generation: claimed.generation,
        names: claimed.names as string[],
        context: context as Endpoint['context'],
      }
      const nativeUrl = from.url
      const root = this.env.method('runtime', 'getURL')?.('')
      const isView =
        typeof root === 'string' &&
        typeof nativeUrl === 'string' &&
        nativeUrl.startsWith(root)
      if (
        (context === 'content-script' && isView) ||
        (context !== 'content-script' && !isView)
      )
        throw fail(
          'ACCESS_DENIED',
          'Endpoint context disagrees with native sender'
        )
      for (const key of [
        'tabId',
        'frameId',
        'windowId',
        'documentId',
      ] as const) {
        const val = from[key]
        if (val !== undefined) Object.assign(e, { [key]: val })
      }
      if (isView && from.documentId) {
        const getContexts = this.env.method('runtime', 'getContexts')
        if (getContexts) {
          const contexts = await getContexts({ documentIds: [from.documentId] })
          const native = Array.isArray(contexts)
            ? contexts
                .map(object)
                .filter((c) => c?.documentId === from.documentId)
            : []
          if (native.length === 1)
            for (const key of ['tabId', 'frameId', 'windowId'] as const) {
              const val = native[0]?.[key]
              if (validId(val)) Object.assign(e, { [key]: val })
            }
        }
      }
      if (context === 'content-script') {
        if (
          !validId(e.tabId) ||
          !validId(e.frameId) ||
          (claimed.world !== 'ISOLATED' && claimed.world !== 'MAIN')
        )
          throw fail('ACCESS_DENIED', 'Content endpoint lacks native identity')
        e.world = claimed.world as 'ISOLATED' | 'MAIN'
      }
      if (v.type === 'register' && e.names.length) await this.refreshWindow(e)
      const existing = this.endpoints.get(e.instanceId)
      if (existing && existing.port !== p)
        throw fail('ACCESS_DENIED', 'Duplicate endpoint identity')
      await this.serialize(async () => {
        const current = this.endpoints.get(e.instanceId)
        if (
          current &&
          (current.port !== p || current.endpoint.generation >= e.generation)
        )
          throw fail('VALIDATION_ERROR', 'Stale endpoint generation')
        const key = `${RECORD_PREFIX}${e.instanceId}`
        if (v.type === 'unregister' || !e.names.length) {
          await this.env.call(['storage', 'session', 'remove'], key)
          if (this.endpoints.get(e.instanceId)?.port === p)
            this.endpoints.delete(e.instanceId)
        } else {
          await this.env.call(['storage', 'session', 'set'], { [key]: e })
          if (this.ports.has(p) && !this.stopped)
            this.endpoints.set(e.instanceId, { endpoint: e, port: p })
        }
      })
      p.postMessage(success(id, undefined))
    } catch (error) {
      try {
        p.postMessage(failure(id, error))
      } catch {
        /* Disconnected: sender observes transport error. */
      }
    }
  }
  private async refreshWindow(e: Endpoint): Promise<void> {
    if (e.tabId === undefined) return
    const get = this.env.method('tabs', 'get')
    if (!get) throw fail('CONTEXT_UNAVAILABLE', 'tabs.get unavailable')
    const tab = object(await get(e.tabId))
    if (!validId(tab?.windowId))
      throw fail('CONTEXT_UNAVAILABLE', 'Tab has no current window')
    e.windowId = tab.windowId
  }
  private async restore(until: number): Promise<void> {
    if (!this.restored) {
      this.restored = this.restoreCandidates(until)
      // Permit explicit retry after a failed verification, without hiding it.
      void this.restored.catch(() => {
        this.restored = undefined
      })
    }
    await deadline(this.restored, until, this.tasks)
  }
  private async restoreCandidates(until: number): Promise<void> {
    // Background-only messaging works without storage permission.
    if (!this.env.method('storage', 'session', 'get'))
      throw fail('PERMISSION_DENIED', 'View routing requires storage.session')
    const records = await this.serialize(() =>
      this.env.call(['storage', 'session', 'get'], null)
    )
    const candidates = Object.entries(object(records) ?? {}).filter(([k]) =>
      k.startsWith(RECORD_PREFIX)
    )
    await Promise.all(
      candidates.map(async ([key, value]) => {
        const e = object(value)
        if (
          !e ||
          typeof e.instanceId !== 'string' ||
          key !== `${RECORD_PREFIX}${e.instanceId}` ||
          !Array.isArray(e.names) ||
          !validId(e.generation) ||
          ![
            'content-script',
            'popup',
            'side-panel',
            'popout',
            'options',
            'extension-page',
            'devtools',
          ].includes(String(e.context)) ||
          ['tabId', 'frameId', 'windowId'].some(
            (key) => e[key] !== undefined && !validId(e[key])
          ) ||
          (e.documentId !== undefined && typeof e.documentId !== 'string') ||
          !e.names.every((n) => typeof n === 'string')
        )
          throw fail('VALIDATION_ERROR', 'Invalid saved endpoint')
        if (this.endpoints.has(e.instanceId)) return
        const control = wire('reconnect', {
          id: crypto.randomUUID(),
          instanceId: e.instanceId,
          deadline: until,
        })
        let ack: unknown
        try {
          const operation =
            e.context === 'content-script'
              ? this.env.method('tabs', 'sendMessage')
              : this.env.method('runtime', 'sendMessage')
          if (!operation)
            throw fail('CONTEXT_UNAVAILABLE', 'Reconnect transport unavailable')
          if (
            e.context === 'content-script' &&
            (!validId(e.tabId) || !validId(e.frameId))
          )
            throw fail('VALIDATION_ERROR', 'Invalid saved content identity')
          const options =
            typeof e.documentId === 'string'
              ? { documentId: e.documentId }
              : { frameId: e.frameId }
          ack = await deadline(
            Promise.resolve(
              e.context === 'content-script'
                ? operation(e.tabId, control, options)
                : operation(control)
            ),
            until,
            this.tasks
          )
        } catch (error) {
          const goneTab =
            e.context === 'content-script' &&
            error instanceof Error &&
            (error.message === `No tab with id: ${e.tabId}.` ||
              error.message === `Invalid tab ID: ${e.tabId}`)
          if (!isMissing(error) && !goneTab)
            throw nativeError('messaging.reconnect', error)
        }
        if (ack === undefined) {
          await this.serialize(async () => {
            // A concurrent fresh registration must survive stale-candidate cleanup.
            if (!this.endpoints.has(String(e.instanceId)))
              await this.env.call(['storage', 'session', 'remove'], key)
          })
          return
        }
        reply(ack, String(object(control)?.id))
        if (!this.endpoints.has(e.instanceId))
          throw fail('TRANSPORT_CLOSED', 'Reconnect ACK without registration')
      })
    )
  }
  async route(r: Request, from: MessageSender): Promise<Reply> {
    try {
      if (r.page && from.context !== 'content-script')
        throw fail('ACCESS_DENIED', 'Page relay requires native content sender')
      from = { ...from, trust: r.page ? 'page' : 'extension' }
      if (from.trust === 'page' && r.name.startsWith('__webext_utils'))
        throw fail('ACCESS_DENIED', 'Page cannot call internal services')
      if (this.stopped) throw fail('ROUTER_UNAVAILABLE', 'Router stopped')
      if (r.deadline <= Date.now()) throw fail('TIMEOUT', 'Request expired')
      if (r.target.context === 'background') {
        const response = await deadline(
          this.dispatch(r, from),
          r.deadline,
          this.tasks
        )
        if (r.mode !== 'all') return response
        if (!response.ok && response.error.code === 'NO_RECEIVER')
          return response
        return success(r.id, {
          results: [
            response.ok
              ? { instanceId: 'background', delivered: true }
              : {
                  instanceId: 'background',
                  delivered: false,
                  error: response.error,
                },
          ],
        })
      }
      await this.restore(r.deadline)
      if (r.target.windowId !== undefined) {
        // Port.sender is a snapshot. Recheck before matching even candidates
        // whose saved window does not match (including after SW restoration).
        await deadline(
          this.serialize(async () => {
            for (const c of this.endpoints.values()) {
              if (!c.endpoint.names.includes(r.name)) continue
              await this.refreshWindow(c.endpoint)
              await this.env.call(['storage', 'session', 'set'], {
                [`${RECORD_PREFIX}${c.endpoint.instanceId}`]: c.endpoint,
              })
            }
          }),
          r.deadline,
          this.tasks
        )
      }
      const selected = [...this.endpoints.values()].filter(
        (c) =>
          c.endpoint.names.includes(r.name) &&
          matches(c.endpoint, r.target, r.mode === 'all')
      )
      if (!selected.length) throw fail('NO_RECEIVER', 'No registered receiver')
      if (r.mode !== 'all' && selected.length !== 1)
        throw fail('AMBIGUOUS_TARGET', 'More than one receiver matches')
      if (r.mode === 'all') {
        const results = await Promise.all(
          selected.map(async (c) => {
            try {
              reply(await this.deliver(c, r, from), r.id)
              return { instanceId: c.endpoint.instanceId, delivered: true }
            } catch (error) {
              const e = nativeError('messaging', error)
              return {
                instanceId: c.endpoint.instanceId,
                delivered: false,
                error: { code: e.code, message: e.message },
              }
            }
          })
        )
        return success(r.id, { results })
      }
      return await this.deliver(selected[0]!, r, from)
    } catch (error) {
      return failure(r.id, error)
    }
  }
  private async deliver(
    c: Connected,
    r: Request,
    from: MessageSender
  ): Promise<Reply> {
    const deliveryId = crypto.randomUUID()
    try {
      const result = await deadline(
        new Promise<unknown>((resolve, reject) => {
          this.pending.set(deliveryId, { port: c.port, resolve, reject })
          try {
            c.port.postMessage(
              wire('deliver', {
                id: deliveryId,
                instanceId: c.endpoint.instanceId,
                request: r,
                sender: from,
              })
            )
          } catch (cause) {
            reject(fail('TRANSPORT_CLOSED', String(cause)))
          }
        }),
        r.deadline,
        this.tasks
      )
      return success(r.id, reply(result, deliveryId))
    } catch (error) {
      return failure(r.id, error)
    } finally {
      this.pending.delete(deliveryId)
    }
  }
  stop(): void {
    this.stopped = true
    for (const cancel of this.tasks)
      cancel(fail('TRANSPORT_CLOSED', 'Router stopped'))
    for (const pending of this.pending.values())
      pending.reject(fail('TRANSPORT_CLOSED', 'Router stopped'))
    this.pending.clear()
    for (const cleanup of this.cleanups) cleanup()
    this.cleanups.clear()
    for (const p of this.ports) p.disconnect()
    this.ports.clear()
    this.endpoints.clear()
  }
}
