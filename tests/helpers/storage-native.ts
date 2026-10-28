import type { StorageArea } from '../../src/storage'

import { object } from '../../src/internal/native'
import { Environment } from '../../src/messaging/environment'
import { Event } from './messaging-native'

export class TestLocks {
  private queues = new Map<string, Promise<unknown>>()
  manager = {
    request: async <T>(name: string, callback: () => Promise<T>) => {
      const previous = this.queues.get(name) ?? Promise.resolve()
      const task = (async () => {
        await previous.catch(() => {})
        return await callback()
      })()
      this.queues.set(
        name,
        task.catch(() => {})
      )
      return await task
    },
  } as unknown as LockManager
}
export class StorageNative {
  data: Record<StorageArea, Record<string, unknown>> = {
    local: {},
    sync: {},
    session: {},
  }
  onChanged = new Event<(changes: unknown, area: unknown) => void>()
  calls: { area: StorageArea; method: string; arg: unknown }[] = []
  failure:
    | ((area: StorageArea, method: string, arg: unknown, index: number) => void)
    | undefined
  locks = new TestLocks()
  api = Object.fromEntries(
    (['local', 'sync', 'session'] as const).map((area) => [
      area,
      Object.fromEntries(
        ['get', 'set', 'remove'].map((method) => [
          method,
          async (arg: unknown) => {
            this.calls.push({ area, method, arg: structuredClone(arg) })
            this.failure?.(area, method, arg, this.calls.length)
            const saved = this.data[area]
            if (method === 'get') {
              const names =
                arg === null
                  ? Object.keys(saved)
                  : typeof arg === 'string'
                    ? [arg]
                    : (arg as string[])
              return structuredClone(
                Object.fromEntries(
                  names
                    .filter((k) => Object.hasOwn(saved, k))
                    .map((k) => [k, saved[k]])
                )
              )
            }
            const changes: Record<string, unknown> = {}
            if (method === 'set') {
              for (const [k, v] of Object.entries(object(arg)!)) {
                changes[k] = {
                  oldValue: Object.hasOwn(saved, k) ? saved[k] : undefined,
                  newValue: v,
                }
                saved[k] = structuredClone(v)
              }
            } else {
              for (const k of typeof arg === 'string'
                ? [arg]
                : (arg as string[])) {
                changes[k] = {
                  oldValue: Object.hasOwn(saved, k) ? saved[k] : undefined,
                }
                delete saved[k]
              }
            }
            this.emit(changes, area)
          },
        ])
      ),
    ])
  )
  emit(changes: unknown, area: StorageArea): void {
    for (const cb of this.onChanged.listeners) cb(changes, area)
  }
  env(): Environment {
    const env = new Environment()
    env.context = {
      get: () => ({ kind: 'extension-page', source: 'native' }),
      resolve: async () => ({ kind: 'extension-page', source: 'native' }),
    }
    const api = { storage: { ...this.api, onChanged: this.onChanged } }
    env.value = (...path) => {
      if (path[0] === 'storage' && path[2] === 'QUOTA_BYTES')
        return path[1] === 'sync' ? 102400 : 10485760
      let value: unknown = api
      for (const k of path) value = object(value)?.[k]
      return value
    }
    env.method = (...path) => {
      let receiver: unknown = api
      for (const k of path.slice(0, -1)) receiver = object(receiver)?.[k]
      const fn = object(receiver)?.[path.at(-1)!]
      return typeof fn === 'function'
        ? (...args) => fn.apply(receiver, args)
        : undefined
    }
    return env
  }
}
