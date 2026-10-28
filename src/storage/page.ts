import type { Unsubscribe } from '../internal/errors'
import type { ServiceClient } from '../messaging/page-services'
import type { PageBridge, PageBridgeLimits } from '../messaging/types'
import type { Change, Operation, StorageRuntime } from './runtime'
import type {
  PageStoragePolicy,
  StorageArea,
  StorageSubscription,
  StorageWatchOptions,
} from './types'

import { WebextError, nativeError } from '../internal/errors'
import { assertJson } from '../internal/json'
import { object } from '../internal/native'
import { PageClient } from '../messaging/page-client'
import {
  registerService,
  serviceClients,
  serviceHosts,
} from '../messaging/page-services'
import { equal, fail, key, within } from './common'
import { parseRequest } from './runtime'
import { subscription } from './subscription'

type Rule = {
  area: StorageArea
  runtime: StorageRuntime
  read: Set<string>
  write: Set<string>
  watch: Set<string>
  validate: Record<string, (value: unknown) => boolean>
}
type Subscription = {
  stop: Unsubscribe
  keys: string[]
  area: StorageArea
  emit(value: unknown): void
}
const hubs = new WeakMap<PageBridge, Hub>()
class Hub {
  rules = new Set<Rule>()
  subscriptions = new Map<string, Subscription>()
  stop: Unsubscribe
  constructor(bridge: PageBridge) {
    this.stop = registerService(bridge, 'storage', this)
  }
  reset(): void {
    for (const sub of this.subscriptions.values()) sub.stop()
    this.subscriptions.clear()
  }
  permission(
    area: StorageArea,
    key: string,
    operation: 'read' | 'write' | 'watch'
  ): Rule {
    const rule = [...this.rules].find(
      (r) => r.area === area && r[operation].has(key)
    )
    if (!rule)
      throw fail('ACCESS_DENIED', 'Storage key or operation is not exposed')
    return rule
  }
  check(rule: Rule, key: string, value: unknown): void {
    if (value === undefined) return
    try {
      if (rule.validate[key]?.(value) === true) return
    } catch {
      /* Fail closed. */
    }
    throw fail('VALIDATION_ERROR', 'Exposed storage value failed validation')
  }
  async request(
    value: unknown,
    emit: (value: unknown) => void
  ): Promise<unknown> {
    const v = object(value)
    if (v?.operation === 'unwatch') {
      if (
        Object.keys(v).some((k) => !['operation', 'id'].includes(k)) ||
        typeof v.id !== 'string'
      )
        throw fail('INVALID_ARGUMENT', 'Invalid storage unsubscribe')
      this.subscriptions.get(v.id)?.stop()
      this.subscriptions.delete(v.id)
      return
    }
    const watching = v?.operation === 'watch'
    if (
      watching &&
      (Object.keys(v).some(
        (k) => !['operation', 'area', 'keys', 'prefix', 'id'].includes(k)
      ) ||
        typeof v.id !== 'string' ||
        v.id.length > 128 ||
        !v.id)
    )
      throw fail('INVALID_ARGUMENT', 'Invalid page storage subscription')
    let expanded = v?.keys
    if (watching && v.keys === undefined) {
      if (typeof v.prefix !== 'string')
        throw fail('INVALID_ARGUMENT', 'Invalid watch namespace')
      if (v.prefix) key(v.prefix)
      expanded = [
        ...new Set(
          [...this.rules]
            .filter((r) => r.area === v.area)
            .flatMap((r) =>
              [...r.watch].filter((k) => within(k, v.prefix as string))
            )
        ),
      ]
    }
    const request = parseRequest(
      watching ? { area: v.area, operation: 'get', keys: expanded } : value
    )
    const operation = watching
      ? 'watch'
      : request.operation === 'get'
        ? 'read'
        : 'write'
    const rules = request.keys.map((k) =>
      this.permission(request.area, k, operation)
    )
    // Validate the whole batch before invoking a single write.
    if (request.operation === 'set')
      request.keys.forEach((k, i) =>
        this.check(rules[i]!, k, request.values[k])
      )
    if (watching) {
      if (!rules.length)
        throw fail('ACCESS_DENIED', 'No storage keys are exposed for watch')
      if (
        this.subscriptions.size >= 256 &&
        !this.subscriptions.has(v.id as string)
      )
        throw fail('QUOTA_EXCEEDED', 'Too many page storage subscriptions')
      const id = v.id as string
      this.subscriptions.get(id)?.stop()
      const runtime = rules[0]?.runtime
      let registered = false
      const stop = runtime?.watch(
        request.area,
        '',
        request.keys,
        (changes) => {
          for (const c of changes) {
            try {
              const rule = this.permission(request.area, c.key, 'watch')
              this.permission(request.area, c.key, 'read')
              this.check(rule, c.key, c.oldValue)
              this.check(rule, c.key, c.newValue)
              emit({ id, change: c })
            } catch {
              /* Never leak rejected values or keys. */
            }
          }
        },
        {
          onError: (error) => {
            if (registered)
              emit({ id, error: { code: error.code, message: error.message } })
          },
        }
      )
      if (!stop) throw fail('ACCESS_DENIED', 'No storage watch runtime')
      this.subscriptions.set(id, {
        stop,
        keys: request.keys,
        area: request.area,
        emit,
      })
      try {
        await stop.ready
      } catch (error) {
        stop()
        if (this.subscriptions.get(id)?.stop === stop)
          this.subscriptions.delete(id)
        throw error
      }
      registered = true
      return { keys: request.keys }
    }
    if (!rules.length) return request.operation === 'get' ? {} : undefined
    const result = await rules[0]!.runtime.execute(
      request.area,
      request.operation,
      request.keys,
      request.values
    )
    if (request.operation === 'get')
      request.keys.forEach((k, i) =>
        this.check(
          rules[i]!,
          k,
          result && Object.hasOwn(result, k) ? result[k] : undefined
        )
      )
    return result
  }
}
export function expose<S>(
  runtime: StorageRuntime,
  area: StorageArea,
  prefix: string,
  bridge: PageBridge,
  policy: PageStoragePolicy<S>
): Unsubscribe {
  if (!serviceHosts.has(bridge))
    throw fail('ACCESS_DENIED', 'An active ISOLATED bridge is required')
  if (runtime.mode() !== 'rpc')
    throw fail('CONTEXT_UNAVAILABLE', 'Storage exposure requires ISOLATED')
  const expand = (names: readonly string[] = []) =>
    new Set(
      names.map((k) => {
        key(k)
        return prefix ? `${prefix}.${k}` : k
      })
    )
  const rule: Rule = {
    runtime,
    area,
    read: expand(policy.read),
    write: expand(policy.write),
    watch: expand(policy.watch),
    validate: {},
  }
  for (const [k, fn] of Object.entries(policy.validate)) {
    key(k)
    if (typeof fn !== 'function')
      throw fail('INVALID_ARGUMENT', 'Invalid page storage validator')
    rule.validate[prefix ? `${prefix}.${k}` : k] = fn as (
      value: unknown
    ) => boolean
  }
  for (const k of new Set([...rule.read, ...rule.write, ...rule.watch]))
    if (!Object.hasOwn(rule.validate, k))
      throw fail(
        'INVALID_ARGUMENT',
        'Every exposed storage key needs a validator'
      )
  for (const k of rule.watch)
    if (!rule.read.has(k))
      throw fail(
        'INVALID_ARGUMENT',
        'Page storage watch also requires read permission'
      )
  let hub = hubs.get(bridge)
  if (!hub) {
    hub = new Hub(bridge)
    hubs.set(bridge, hub)
  }
  for (const other of hub.rules)
    if (
      other.area === area &&
      [...rule.read, ...rule.write, ...rule.watch].some(
        (k) => other.read.has(k) || other.write.has(k) || other.watch.has(k)
      )
    )
      throw fail('INVALID_ARGUMENT', 'Overlapping page storage exposure')
  hub.rules.add(rule)
  const host = hub
  return () => {
    if (!host.rules.delete(rule)) return
    for (const [id, sub] of host.subscriptions)
      if (sub.area === area && sub.keys.some((k) => rule.watch.has(k))) {
        sub.stop()
        host.subscriptions.delete(id)
      }
    if (!host.rules.size) {
      host.stop()
      hubs.delete(bridge)
    }
  }
}
export class PageStorage {
  private service: ServiceClient | undefined
  private observers = new Set<{
    area: StorageArea
    prefix: string
    keys?: string[]
    callback(changes: Change[]): void
    id: string
    snapshot: Record<string, unknown>
    initialized: boolean
    registration?: Promise<void>
    error(cause: unknown): void
  }>()
  private stopEvents: Unsubscribe | undefined
  private stopReconnect: Unsubscribe | undefined
  private pending = 0
  constructor(
    private channel: string,
    private limits?: PageBridgeLimits
  ) {}
  private client(): ServiceClient {
    if (!this.service) {
      this.service = serviceClients.get(
        PageClient.create(this.channel, undefined, this.limits)
      )!
      this.stopEvents = this.service.listen('storage', (raw) => {
        const v = object(raw),
          c = object(v?.change)
        if (v?.error) {
          const error = object(v.error)
          for (const o of this.observers)
            if (o.id === v.id)
              o.error(
                new WebextError(
                  error?.code as WebextError['code'],
                  'storage.watch',
                  String(error?.message)
                )
              )
          return
        }
        if (!v || !c || typeof c.key !== 'string') return
        try {
          key(c.key)
          assertJson(c, 'storage.page.watch')
        } catch {
          return
        }
        for (const o of this.observers)
          if (
            o.id === v.id &&
            within(c.key, o.prefix) &&
            (!o.keys || o.keys.includes(c.key))
          ) {
            if (c.newValue === undefined) delete o.snapshot[c.key]
            else o.snapshot[c.key] = c.newValue
            o.callback([c as Change])
          }
      })
      this.stopReconnect = this.service.reconnect(() => {
        for (const o of this.observers) {
          o.registration = this.subscribe(o)
          void o.registration.catch(o.error)
        }
      })
    }
    return this.service
  }
  private release(): void {
    if (this.pending || this.observers.size) return
    this.stopEvents?.()
    this.stopReconnect?.()
    this.service?.dispose()
    this.service = undefined
  }
  async execute(
    area: StorageArea,
    operation: Operation,
    keys: string[],
    values: Record<string, unknown> = {}
  ): Promise<Record<string, unknown> | undefined> {
    this.pending++
    try {
      return (await this.client().request('storage', {
        area,
        operation,
        keys,
        values,
      })) as Record<string, unknown> | undefined
    } finally {
      this.pending--
      this.release()
    }
  }
  private async subscribe(
    o: typeof this.observers extends Set<infer O> ? O : never
  ): Promise<void> {
    // watchAll has no schema at runtime. The privileged host expands a namespace.
    const client = this.client()
    const response = object(
      await client.request('storage', {
        operation: 'watch',
        area: o.area,
        ...(o.keys ? { keys: o.keys } : { prefix: o.prefix }),
        id: o.id,
      })
    )
    const selected = response?.keys
    if (
      !Array.isArray(selected) ||
      !selected.every((k) => typeof k === 'string' && within(k, o.prefix))
    )
      throw fail('VALIDATION_ERROR', 'Invalid page watch response')
    if (!this.observers.has(o)) return
    const snapshot: Record<string, unknown> = Object.assign(
      Object.create(null),
      await this.execute(o.area, 'get', selected)
    )
    if (!this.observers.has(o)) return
    if (o.initialized) {
      const changes: Change[] = []
      for (const k of new Set([
        ...Object.keys(o.snapshot),
        ...Object.keys(snapshot),
      ]))
        if (!equal(o.snapshot[k], snapshot[k]))
          changes.push({
            key: k,
            oldValue: o.snapshot[k],
            newValue: snapshot[k],
          })
      if (changes.length) o.callback(changes)
    }
    o.snapshot = snapshot
    o.initialized = true
  }
  watch(
    area: StorageArea,
    prefix: string,
    keys: string[] | undefined,
    callback: (changes: Change[]) => void,
    options?: StorageWatchOptions
  ): StorageSubscription {
    const o: typeof this.observers extends Set<infer O> ? O : never = {
      area,
      prefix,
      ...(keys ? { keys } : {}),
      callback,
      id: crypto.randomUUID(),
      snapshot: {},
      initialized: false,
      error: (cause) => {
        if (!this.observers.has(o)) return
        stop()
        try {
          options?.onError?.(nativeError('storage.watch', cause))
        } catch {
          /* Independent error observer. */
        }
      },
    }
    this.observers.add(o)
    o.registration = this.subscribe(o)
    const stop = subscription(
      () => {
        if (!this.observers.delete(o)) return
        this.pending++
        void (async () => {
          try {
            try {
              await o.registration
            } catch {
              /* Remove a possibly accepted watch. */
            }
            await this.client().request('storage', {
              operation: 'unwatch',
              id: o.id,
            })
          } catch {
            /* The privileged peer may already be gone. */
          } finally {
            this.pending--
            this.release()
          }
        })()
      },
      o.registration,
      options
    )
    return stop
  }
}
