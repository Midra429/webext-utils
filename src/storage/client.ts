import type { PageBridge } from '../messaging/types'
import type { Change } from './runtime'
import type {
  MigrationPlan,
  PageStoragePolicy,
  StorageClient,
  StorageOptions,
  StorageSubscription,
  StorageWatchOptions,
} from './types'

import { object } from '../internal/browser'
import { assertJson } from '../internal/json'
import { PageStorage, expose } from './page-bridge'
import { StorageRuntime } from './runtime'
import { clone, fail, join, key, keys, segments } from './utils'

// No native globals, listeners or transports are touched by factory creation.
let shared: StorageRuntime | undefined
export function current(): StorageRuntime {
  return (shared ??= new StorageRuntime())
}
export function createStorage<S>(
  options: StorageOptions<S> = {},
  runtime: () => StorageRuntime = current
): StorageClient<S> {
  const area = options.area ?? 'local'
  if (!['local', 'sync', 'session'].includes(area))
    throw fail('INVALID_ARGUMENT', 'Invalid storage area')
  const validators = { ...options.validate } as Record<
    string,
    (value: unknown) => boolean
  >
  for (const [k, fn] of Object.entries(validators)) {
    key(k)
    if (typeof fn !== 'function')
      throw fail('INVALID_ARGUMENT', 'Invalid storage validator')
  }
  const bridge = options.bridge
    ? new PageStorage(options.bridge.channel, options.bridge.limits)
    : undefined
  function parse(k: string, value: unknown): unknown {
    if (value === undefined) return undefined
    const input = clone(value)
    if (!Object.hasOwn(validators, k)) return input
    let valid = false
    try {
      valid = validators[k]!(input) === true
    } catch (cause) {
      throw fail('VALIDATION_ERROR', `Storage validator failed: ${k}`, cause)
    }
    if (!valid) throw fail('VALIDATION_ERROR', `Storage value is invalid: ${k}`)
    return input
  }
  function store(prefix: string): StorageClient<S> {
    const full = (k: string) => join(prefix, k)
    const execute = async (
      op: 'get' | 'set' | 'remove',
      names: string[],
      values: Record<string, unknown> = {}
    ) => {
      return await (bridge
        ? bridge.execute(area, op, names, values)
        : runtime().execute(area, op, names, values))
    }
    async function getMany(
      names: readonly string[]
    ): Promise<Record<string, unknown>> {
      if (!Array.isArray(names))
        throw fail('INVALID_ARGUMENT', 'Expected storage keys')
      const expanded = names.map(full)
      const saved = object(await execute('get', expanded))
      if (!saved) throw fail('VALIDATION_ERROR', 'Invalid storage response')
      return Object.fromEntries(
        names.map((k, i) => {
          const name = expanded[i]!
          return [
            k,
            parse(name, Object.hasOwn(saved, name) ? saved[name] : undefined),
          ]
        })
      )
    }
    async function setMany(values: Record<string, unknown>): Promise<void> {
      assertJson(values, 'storage.setMany')
      if (!object(values) || Array.isArray(values))
        throw fail('INVALID_ARGUMENT', 'Expected storage values')
      const expanded = Object.fromEntries(
        Object.entries(values).map(([k, v]) => {
          const name = full(k)
          if (v === undefined)
            throw fail('SERIALIZATION_ERROR', 'Cannot store undefined')
          const parsed = parse(name, v)
          return [name, parsed]
        })
      )
      await execute('set', Object.keys(expanded), expanded)
    }
    function watch(
      selected: string[] | undefined,
      callback: (change: {
        key: string
        oldValue: unknown
        newValue: unknown
      }) => void,
      options?: StorageWatchOptions
    ): StorageSubscription {
      if (typeof callback !== 'function')
        throw fail('INVALID_ARGUMENT', 'Invalid storage observer')
      const onChange = (changes: Change[]) => {
        for (const c of changes) {
          let oldValue: unknown, newValue: unknown
          try {
            oldValue = parse(c.key, c.oldValue)
            newValue = parse(c.key, c.newValue)
          } catch {
            continue
          }
          callback({
            key: prefix ? c.key.slice(prefix.length + 1) : c.key,
            oldValue,
            newValue,
          })
        }
      }
      return bridge
        ? bridge.watch(area, prefix, selected, onChange, options)
        : runtime().watch(area, prefix, selected, onChange, options)
    }
    return {
      get: async (k: string) => (await getMany([k]))[k],
      getMany,
      set: async (k: string, v: unknown) => {
        await setMany({ [k]: v })
      },
      setMany,
      remove: async (k: string) => {
        await execute('remove', [full(k)])
      },
      removeMany: async (names: readonly string[]) => {
        if (!Array.isArray(names))
          throw fail('INVALID_ARGUMENT', 'Expected storage keys')
        await execute('remove', names.map(full))
      },
      namespace: (p: string) => {
        segments(p)
        return store(prefix ? `${prefix}.${p}` : p)
      },
      watch: (
        k: string,
        cb: (change: unknown) => void,
        opts?: StorageWatchOptions
      ) => watch([full(k)], cb, opts),
      watchAll: (
        names: string[] | ((change: unknown) => void),
        cb?: ((change: unknown) => void) | StorageWatchOptions,
        opts?: StorageWatchOptions
      ) =>
        typeof names === 'function'
          ? watch(undefined, names, cb as StorageWatchOptions | undefined)
          : watch(keys(names).map(full), cb as (change: unknown) => void, opts),
      migrate: async (plan: MigrationPlan) => {
        if (bridge) throw fail('ACCESS_DENIED', 'MAIN cannot migrate storage')
        if (runtime().mode() !== 'direct')
          throw fail('ACCESS_DENIED', 'Content Scripts cannot migrate storage')
        return await runtime().engine.migrate(area, prefix, plan)
      },
      exposeToPage: (target: PageBridge, policy: PageStoragePolicy<S>) => {
        if (bridge) throw fail('ACCESS_DENIED', 'MAIN cannot expose storage')
        return expose(runtime(), area, prefix, target, policy)
      },
    } as unknown as StorageClient<S>
  }
  return store('')
}
