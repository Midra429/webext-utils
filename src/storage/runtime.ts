import type { Unsubscribe } from '../internal/errors'
import type { Realm } from '../messaging/realm'
import type { MessageSender, MessageTarget } from '../messaging/types'
import type {
  StorageArea,
  StorageBackgroundOptions,
  StorageSubscription,
  StorageWatchOptions,
} from './types'

import { nativeError } from '../internal/errors'
import { assertJson } from '../internal/json'
import { object } from '../internal/native'
import { Environment } from '../messaging/environment'
import { currentRealm } from '../messaging/shared'
import { clone, equal, fail, key, keys, within } from './common'
import { StorageEngine } from './engine'
import { subscription } from './subscription'

const uuid = /^[0-9a-f-]{36}$/
const RPC = '__webext_utils__storage_rpc_v1'
const SUBSCRIPTIONS = '__webext_utils__storage_subscriptions_v1'
export type Change = { key: string; oldValue?: unknown; newValue?: unknown }
export type Operation = 'get' | 'set' | 'remove'
type Subscription = {
  area: StorageArea
  prefix: string
  keys?: string[]
  receiver: string
  target: MessageTarget
}
function area(value: unknown): asserts value is StorageArea {
  if (!['local', 'sync', 'session'].includes(String(value)))
    throw fail('INVALID_ARGUMENT', 'Invalid storage area')
}
export function parseRequest(value: unknown): {
  area: StorageArea
  operation: Operation
  keys: string[]
  values: Record<string, unknown>
} {
  const v = object(value)
  if (
    !v ||
    Object.keys(v).some(
      (k) => !['area', 'operation', 'keys', 'values'].includes(k)
    )
  )
    throw fail('INVALID_ARGUMENT', 'Invalid storage request')
  area(v.area)
  if (!['get', 'set', 'remove'].includes(String(v.operation)))
    throw fail('ACCESS_DENIED', 'Storage operation is not allowed')
  const names = keys(v.keys)
  const values = v.values === undefined ? {} : object(v.values)
  if (!values || (v.operation !== 'set' && Object.keys(values).length))
    throw fail('INVALID_ARGUMENT', 'Invalid storage values')
  if (
    v.operation === 'set' &&
    (Object.keys(values).length !== names.length ||
      names.some((k) => !Object.hasOwn(values, k)))
  )
    throw fail('INVALID_ARGUMENT', 'Storage keys and values differ')
  assertJson(values, 'storage')
  return {
    area: v.area,
    operation: v.operation as Operation,
    keys: names,
    values: clone(values),
  }
}
export class StorageRuntime {
  readonly engine: StorageEngine
  private nativeObservers = new Set<
    (changes: Change[], area: StorageArea) => void
  >()
  private removeNative: Unsubscribe | undefined
  private started = false
  private backgroundEpoch = 0
  constructor(
    readonly env = new Environment(),
    private realm: () => Realm = currentRealm,
    locks?: () => LockManager | undefined
  ) {
    this.engine = new StorageEngine(env, locks)
  }
  mode(): 'direct' | 'rpc' {
    const context = this.env.context.get()
    if (context.kind === 'unknown')
      throw fail('CONTEXT_UNAVAILABLE', 'Storage context is unavailable')
    if (context.kind === 'content-script') {
      if (context.world === 'MAIN')
        throw fail('ACCESS_DENIED', 'MAIN storage requires a bridge')
      return 'rpc'
    }
    return 'direct'
  }
  private async send(value: unknown): Promise<unknown> {
    return await this.realm().send(
      RPC,
      value,
      { target: { context: 'background' } },
      'send',
      new Set(),
      false,
      true
    )
  }
  async execute(
    a: StorageArea,
    operation: Operation,
    names: string[],
    values: Record<string, unknown> = {}
  ): Promise<Record<string, unknown> | undefined> {
    const request = parseRequest({ area: a, operation, keys: names, values })
    if (this.mode() === 'rpc')
      return (await this.send(request)) as Record<string, unknown> | undefined
    return await this.direct(request)
  }
  private async direct(
    request: ReturnType<typeof parseRequest>,
    external = false
  ): Promise<Record<string, unknown> | undefined> {
    return await this.engine.locked(
      request.area,
      async () => {
        const { area, operation, keys, values } = request
        if (operation === 'get') {
          const saved = await this.engine.read(area, keys)
          return Object.fromEntries(
            keys
              .filter((k) => saved[k] !== undefined)
              .map((k) => [k, clone(saved[k])])
          )
        }
        if (keys.length)
          await this.engine.call(
            area,
            operation === 'set' ? 'set' : 'remove',
            operation === 'set' ? values : keys
          )
      },
      external
    )
  }
  observe(
    callback: (changes: Change[], area: StorageArea) => void
  ): Unsubscribe {
    this.nativeObservers.add(callback)
    try {
      this.removeNative ??= this.env.listen(
        ['storage', 'onChanged'],
        (raw, a) => {
          if (!['local', 'sync', 'session'].includes(String(a))) return
          const changes: Change[] = []
          for (const [name, value] of Object.entries(object(raw) ?? {})) {
            try {
              key(name)
              const v = object(value)
              if (!v || equal(v.oldValue, v.newValue)) continue
              assertJson(v.oldValue, 'storage.watch', true)
              assertJson(v.newValue, 'storage.watch', true)
              changes.push({
                key: name,
                ...(v.oldValue === undefined
                  ? {}
                  : { oldValue: clone(v.oldValue) }),
                ...(v.newValue === undefined
                  ? {}
                  : { newValue: clone(v.newValue) }),
              })
            } catch {
              /* Metadata and non-JSON native values are not public events. */
            }
          }
          if (!changes.length) return
          for (const cb of this.nativeObservers) {
            try {
              cb(changes, a as StorageArea)
            } catch {
              /* Observers are independent. */
            }
          }
        }
      )
    } catch (error) {
      this.nativeObservers.delete(callback)
      throw error
    }
    return () => {
      this.nativeObservers.delete(callback)
      if (!this.nativeObservers.size) {
        this.removeNative?.()
        this.removeNative = undefined
      }
    }
  }
  watch(
    a: StorageArea,
    prefix: string,
    selected: string[] | undefined,
    callback: (changes: Change[]) => void,
    options?: StorageWatchOptions
  ): StorageSubscription {
    const matches = (c: Change) =>
      within(c.key, prefix) && (!selected || selected.includes(c.key))
    if (this.mode() === 'direct')
      return subscription(
        this.observe((changes, changedArea) => {
          if (changedArea === a) callback(changes.filter(matches))
        }),
        Promise.resolve(),
        options
      )
    const id = crypto.randomUUID(),
      receiver = `__webext_utils__storage_watch_${id}`,
      owner = {}
    let active = true
    const stop = this.realm().on(
      owner,
      receiver,
      (value, sender) => {
        if (
          sender.context !== 'background' ||
          sender.trust !== 'extension' ||
          !Array.isArray(value)
        )
          throw fail('ACCESS_DENIED', 'Invalid storage event sender')
        const valid: Change[] = []
        for (const c of value) {
          const v = object(c)
          if (!v) throw fail('VALIDATION_ERROR', 'Invalid storage event')
          key(v.key)
          if (!matches(v as Change))
            throw fail('ACCESS_DENIED', 'Storage event outside subscription')
          valid.push(v as Change)
        }
        if (active) callback(valid)
      },
      true
    )
    let registered = false
    const stopErrors = this.realm().observeRegistrationErrors((cause) => {
      if (!registered || !active) return
      handle()
      try {
        options?.onError?.(nativeError('storage.watch', cause))
      } catch {
        /* Independent error observer. */
      }
    })
    const registration = (async () => {
      const instanceId = await this.realm().internalInstance()
      if (!active) return
      await this.send({
        operation: 'subscribe',
        area: a,
        prefix,
        ...(selected ? { keys: selected } : {}),
        id,
        receiver,
        instanceId,
      })
      registered = true
    })()
    const handle = subscription(
      () => {
        if (!active) return
        active = false
        stopErrors()
        stop()
        void (async () => {
          try {
            await registration
          } catch {
            /* Still remove any accepted request. */
          }
          try {
            await this.send({ operation: 'unsubscribe', id })
          } catch {
            /* Context teardown. */
          }
        })()
      },
      registration,
      options
    )
    return handle
  }
  private async subscriptions(
    update?: (saved: Record<string, Subscription>) => void
  ): Promise<Record<string, Subscription>> {
    const locks = this.engine.locks()
    const work = async () => {
      const saved =
        (object(
          (await this.engine.read('session', [SUBSCRIPTIONS]))[SUBSCRIPTIONS]
        ) as Record<string, Subscription> | undefined) ?? {}
      if (update) {
        update(saved)
        await this.engine.call('session', 'set', { [SUBSCRIPTIONS]: saved })
      }
      return saved
    }
    // This metadata has its own lock; never recursively acquire the data lock.
    if (!locks)
      throw fail(
        'UNSUPPORTED_OPERATION',
        'Storage subscriptions require Web Locks'
      )
    return await locks.request(SUBSCRIPTIONS, work)
  }
  private async prune(tabId?: number, removed = false): Promise<void> {
    const epoch = this.backgroundEpoch
    const snapshot = await this.subscriptions()
    if (!this.started || epoch !== this.backgroundEpoch) return
    const gone: [string, Subscription][] = []
    await Promise.all(
      Object.entries(snapshot).map(async ([id, sub]) => {
        if (tabId !== undefined && sub.target.tabId !== tabId) return
        if (removed) {
          gone.push([id, sub])
          return
        }
        try {
          // An empty notification tests this exact receiver without exposing data
          // or invoking a user's observer. Router reconnect verifies saved docs.
          await this.realm().send(
            sub.receiver,
            [],
            { target: sub.target, timeoutMs: 2000 },
            'notify',
            new Set(),
            false,
            true
          )
        } catch (error) {
          if (object(error)?.code === 'NO_RECEIVER') gone.push([id, sub])
        }
      })
    )
    if (!gone.length) return
    await this.subscriptions((saved) => {
      if (!this.started || epoch !== this.backgroundEpoch) return
      for (const [id, old] of gone) {
        const current = saved[id]
        if (
          current?.receiver === old.receiver &&
          equal(current.target, old.target)
        )
          delete saved[id]
      }
    })
  }
  startBackground(options: StorageBackgroundOptions = {}): Unsubscribe {
    if (this.env.context.get().kind !== 'background')
      throw fail(
        'CONTEXT_UNAVAILABLE',
        'Storage Background registration requires Background'
      )
    if (this.started)
      throw fail('INVALID_ARGUMENT', 'Storage Background already registered')
    const access = {
      local: true,
      sync: true,
      session: false,
      ...options.contentScriptAccess,
    }
    if (
      Object.entries(access).some(
        ([k, v]) =>
          !['local', 'sync', 'session'].includes(k) || typeof v !== 'boolean'
      )
    )
      throw fail('INVALID_ARGUMENT', 'Invalid contentScriptAccess')
    const own = (sender: MessageSender) => {
      if (sender.trust !== 'extension' || sender.context !== 'content-script')
        throw fail(
          'ACCESS_DENIED',
          'Storage RPC requires an extension Content Script'
        )
    }
    const targetFor = (
      sender: MessageSender,
      instanceId: string
    ): MessageTarget => ({
      context: 'content-script',
      world: 'ISOLATED',
      tabId: sender.tabId!,
      frameId: sender.frameId ?? 0,
      ...(sender.documentId ? { documentId: sender.documentId } : {}),
      instanceId,
    })
    const owner = {}
    const stopRPC = this.realm().on(
      owner,
      RPC,
      async (value, sender) => {
        own(sender)
        const v = object(value)
        if (v?.operation === 'unsubscribe') {
          if (typeof v.id !== 'string')
            throw fail('INVALID_ARGUMENT', 'Invalid subscription ID')
          await this.subscriptions((saved) => {
            const s = saved[v.id as string]
            if (
              s &&
              s.target.context === 'content-script' &&
              s.target.tabId === sender.tabId &&
              s.target.documentId === sender.documentId &&
              s.target.frameId === (sender.frameId ?? 0)
            )
              delete saved[v.id as string]
          })
          return
        }
        area(v?.area)
        if (!access[v.area as StorageArea])
          throw fail(
            'ACCESS_DENIED',
            'Content Script access to storage area is disabled'
          )
        if (v.operation === 'subscribe') {
          if (
            Object.keys(v).some(
              (k) =>
                ![
                  'operation',
                  'area',
                  'prefix',
                  'keys',
                  'id',
                  'receiver',
                  'instanceId',
                ].includes(k)
            ) ||
            typeof v.id !== 'string' ||
            !uuid.test(v.id) ||
            v.receiver !== `__webext_utils__storage_watch_${v.id}` ||
            typeof v.instanceId !== 'string' ||
            typeof v.prefix !== 'string'
          )
            throw fail('INVALID_ARGUMENT', 'Invalid storage subscription')
          if (v.prefix) key(v.prefix)
          const selected = v.keys === undefined ? undefined : keys(v.keys)
          if (selected?.some((k) => !within(k, v.prefix as string)))
            throw fail('INVALID_ARGUMENT', 'Subscription outside namespace')
          if (Object.keys(await this.subscriptions()).length >= 1024)
            await this.prune()
          await this.subscriptions((saved) => {
            if (
              Object.keys(saved).length >= 1024 &&
              !Object.hasOwn(saved, v.id as string)
            )
              throw fail('QUOTA_EXCEEDED', 'Too many storage subscriptions')
            saved[v.id as string] = {
              area: v.area as StorageArea,
              prefix: v.prefix as string,
              ...(selected ? { keys: selected } : {}),
              receiver: v.receiver as string,
              target: targetFor(sender, v.instanceId as string),
            }
          })
          return
        }
        return await this.direct(parseRequest(v), true)
      },
      true
    )
    let stopWatch: Unsubscribe
    const stops: Unsubscribe[] = []
    try {
      stopWatch = this.observe((changes, a) => {
        void (async () => {
          for (const [id, sub] of Object.entries(await this.subscriptions())) {
            if (sub.area !== a || !access[a]) continue
            const filtered = changes.filter(
              (c) =>
                within(c.key, sub.prefix) &&
                (!sub.keys || sub.keys.includes(c.key))
            )
            if (!filtered.length) continue
            try {
              await this.realm().send(
                sub.receiver,
                filtered,
                { target: sub.target },
                'notify',
                new Set(),
                false,
                true
              )
            } catch (error) {
              if (object(error)?.code === 'NO_RECEIVER')
                await this.subscriptions((saved) => {
                  delete saved[id]
                })
            }
          }
        })().catch(() => {})
      })
      const prune = (tabId: unknown, removed: boolean) => {
        if (typeof tabId !== 'number') return
        void this.prune(tabId, removed).catch(() => {
          /* Preserve records on native failure; retry at navigation/capacity. */
        })
      }
      stops.push(
        this.realm().observeDisconnects((sender) => {
          if (sender.context === 'content-script') prune(sender.tabId, false)
        })
      )
      stops.push(
        this.env.listen(['tabs', 'onRemoved'], (tabId) => prune(tabId, true))
      )
      stops.push(
        this.env.listen(['tabs', 'onUpdated'], (tabId, change) => {
          if (object(change)?.status === 'complete') prune(tabId, false)
        })
      )
    } catch (error) {
      for (const stop of stops) stop()
      stopWatch!?.()
      stopRPC()
      throw error
    }
    this.started = true
    let active = true
    return () => {
      if (!active) return
      active = false
      this.started = false
      this.backgroundEpoch++
      stopRPC()
      stopWatch()
      for (const stop of stops) stop()
    }
  }
}
