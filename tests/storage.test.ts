import type { StorageArea } from '../src/storage'

import { describe, expect, test } from 'bun:test'

import { webextStorage } from '../src/storage'
import { createStorage } from '../src/storage/client'
import { JOURNAL, META, SYNC_JOURNAL } from '../src/storage/common'
import { StorageRuntime } from '../src/storage/runtime'
import { StorageNative } from './helpers/storage-native'

type Schema = {
  'settings.theme': 'light' | 'dark'
  'settings.language': string
  'settings.editor.fontSize': number
  'settings.notifications': boolean
  'settingsExtra.theme': string
  'cache.lastTitle': string
}
function setup(area: StorageArea = 'local', native = new StorageNative()) {
  const runtime = new StorageRuntime(
    native.env(),
    undefined,
    () => native.locks.manager
  )
  const storage = createStorage<Schema>({ area }, () => runtime)
  return { native, runtime, storage }
}
const plan = {
  version: 3,
  steps: {
    1: (draft: import('../src/storage').MigrationDraft) => {
      draft.set('theme', 'light')
      draft.remove('obsolete')
    },
    2: async (draft: import('../src/storage').MigrationDraft) => {
      draft.set('language', 'ja')
    },
    3: (draft: import('../src/storage').MigrationDraft) => {
      draft.set('notifications', true)
    },
  },
}
describe('storage CRUD and watch', () => {
  test('prototype-named keys remain ordinary optional storage keys', async () => {
    const { runtime } = setup()
    const storage = createStorage<Record<string, string>>({}, () => runtime)
    for (const name of ['toString', 'valueOf', 'hasOwnProperty']) {
      expect(await storage.get(name)).toBeUndefined()
      await storage.set(name, 'saved')
      expect(await storage.get(name)).toBe('saved')
      await storage.remove(name)
      expect(await storage.get(name)).toBeUndefined()
    }
  })
  test('migration drafts and versions do not read inherited properties', async () => {
    const { runtime } = setup()
    const storage = createStorage<Record<string, string>>({}, () => runtime)
    await storage.migrate({
      version: 1,
      steps: {
        1: (draft) => {
          expect(draft.get('toString')).toBeUndefined()
          draft.set('toString', 'saved')
        },
      },
    })
    expect(await storage.get('toString')).toBe('saved')
    await storage.migrate({
      version: 2,
      steps: { 2: (draft) => draft.remove('toString') },
    })
    expect(await storage.get('toString')).toBeUndefined()

    const other = setup()
    const namespaced = createStorage<{
      'settings.theme': string
      'toString.theme': string
      'valueOf.theme': string
    }>({}, () => other.runtime)
    for (const name of ['settings', 'toString', 'valueOf'] as const) {
      const result = await namespaced.namespace(name).migrate({
        version: 1,
        steps: { 1: (draft) => draft.set('theme', 'dark') },
      })
      expect(result.applied).toEqual([1])
      expect(await namespaced.namespace(name).get('theme')).toBe('dark')
    }
  })
  test('factory and namespaces do not use native APIs', () => {
    let accesses = 0
    const storage = createStorage<Schema>({}, () => {
      accesses++
      throw Error('must stay lazy')
    })
    storage.namespace('settings').namespace('editor')
    webextStorage<Schema>({ bridge: { channel: 'public' } }).namespace(
      'settings'
    )
    expect(accesses).toBe(0)
  })
  for (const area of ['local', 'sync', 'session'] as const)
    test(`${area}: typed CRUD, batches and missing values`, async () => {
      const { storage, native } = setup(area)
      expect(await storage.get('settings.theme')).toBeUndefined()
      expect(
        await storage.getMany(['settings.theme', 'settings.language'] as const)
      ).toEqual({ 'settings.theme': undefined, 'settings.language': undefined })
      await storage.setMany({
        'settings.theme': 'dark',
        'settings.language': 'ja',
      })
      expect(await storage.get('settings.theme')).toBe('dark')
      expect(native.data[area]['settings.theme']).toBe('dark')
      await storage.removeMany(['settings.theme', 'settings.language'])
      await storage.remove('settings.theme')
      expect(await storage.get('settings.language')).toBeUndefined()
      expect(
        native.calls.some((c) => c.method === 'get' && c.arg === null)
      ).toBe(false)
      expect(
        native.calls.some(
          (c) => c.method === 'set' && Object.hasOwn(c.arg as object, JOURNAL)
        )
      ).toBe(false)
    })
  test('nested namespace uses physical full keys and exact dot boundary', async () => {
    const { storage, native } = setup()
    await storage.namespace('settings').namespace('editor').set('fontSize', 16)
    expect(await storage.namespace('settings.editor').get('fontSize')).toBe(16)
    expect(native.data.local).toEqual({ 'settings.editor.fontSize': 16 })
    const events: unknown[] = []
    const stop = storage.namespace('settings').watchAll((e) => events.push(e))
    await storage.set('settingsExtra.theme', 'x')
    await storage.namespace('settings').set('theme', 'dark')
    expect(events).toEqual([
      { key: 'theme', oldValue: undefined, newValue: 'dark' },
    ])
    stop()
  })
  test('invalid and reserved keys and non-JSON batches fail before mutation', async () => {
    const { storage, native } = setup()
    const raw = storage as unknown as {
      set(key: string, value: unknown): Promise<void>
      setMany(value: unknown): Promise<void>
    }
    for (const k of [
      '',
      'a..b',
      '.a',
      'a.',
      '__webext_utils__x',
      'settings.__webext_utils__meta',
      '__proto__',
      'constructor',
    ])
      await expect(raw.set(k, 1)).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      })
    for (const value of [undefined, NaN, new Date(), () => 1, { x: undefined }])
      await expect(raw.set('x', value)).rejects.toMatchObject({
        code: 'SERIALIZATION_ERROR',
      })
    await expect(
      raw.setMany({ 'settings.theme': 'light', 'bad..key': true })
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(native.calls).toHaveLength(0)
  })
  test('parsers validate reads and full batches before a write', async () => {
    const { native, runtime } = setup()
    const storage = createStorage<Schema>(
      {
        validate: {
          'settings.theme': (value) => {
            if (value !== 'light' && value !== 'dark') throw Error('bad')
            return value
          },
        },
      },
      () => runtime
    )
    native.data.local['settings.theme'] = 'legacy'
    await expect(storage.get('settings.theme')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      cause: expect.any(Error),
    })
    await expect(
      storage.setMany({
        'settings.language': 'en',
        'settings.theme': 'wrong' as 'dark',
      })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(native.data.local['settings.language']).toBeUndefined()
  })
  test('one native listener, no initial event, no-ops, deletes and cleanup', async () => {
    const { storage, native } = setup()
    const theme: unknown[] = [],
      all: unknown[] = []
    const stop = storage
      .namespace('settings')
      .watch('theme', (c) => theme.push(c))
    const stopAll = storage.namespace('settings').watchAll((c) => all.push(c))
    expect(native.onChanged.listeners.size).toBe(1)
    expect(theme).toEqual([])
    await storage.set('settings.theme', 'dark')
    await storage.set('settings.theme', 'dark')
    native.emit(
      {
        x: { oldValue: { a: 1, b: 2 }, newValue: { b: 2, a: 1 } },
        [META]: { newValue: {} },
      },
      'local'
    )
    native.emit({ 'settings.theme': { newValue: 'light' } }, 'sync')
    await storage.remove('settings.theme')
    expect(theme).toEqual([
      { key: 'theme', oldValue: undefined, newValue: 'dark' },
      { key: 'theme', oldValue: 'dark', newValue: undefined },
    ])
    expect(all).toHaveLength(2)
    stop()
    stop()
    expect(native.onChanged.listeners.size).toBe(1)
    stopAll()
    expect(native.onChanged.listeners.size).toBe(0)
  })
  test('quota, permission, unsupported area and unavailable locks stay explicit', async () => {
    const { native, storage, runtime } = setup()
    native.failure = () => {
      throw Error('QUOTA_BYTES exceeded')
    }
    await expect(storage.set('settings.theme', 'dark')).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
      cause: expect.any(Error),
    })
    native.failure = () => {
      throw Error('Permission denied')
    }
    await expect(storage.get('settings.theme')).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    })
    native.failure = undefined
    const withoutLocks = new StorageRuntime(
      native.env(),
      undefined,
      () => undefined
    )
    await expect(
      createStorage<Schema>({}, () => withoutLocks).migrate({
        version: 0,
        steps: {},
      })
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' })
    runtime.env.method = () => undefined
    await expect(storage.get('settings.theme')).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    })
    await expect(
      createStorage<Schema>({ area: 'session' }, () => runtime).get(
        'settings.theme'
      )
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' })
  })
})
describe('storage migrations and recovery', () => {
  test('fresh and unversioned installs, ordered async steps, same version', async () => {
    for (const legacy of [false, true]) {
      const { storage, native } = setup()
      if (legacy) native.data.local['settings.obsolete'] = 1
      expect(await storage.namespace('settings').migrate(plan)).toEqual({
        fromVersion: 0,
        toVersion: 3,
        applied: [1, 2, 3],
      })
      expect(
        await storage
          .namespace('settings')
          .getMany(['theme', 'language', 'notifications'])
      ).toEqual({ theme: 'light', language: 'ja', notifications: true })
      expect(native.data.local['settings.obsolete']).toBeUndefined()
      expect(native.data.local[JOURNAL]).toBeUndefined()
      expect(await storage.namespace('settings').migrate(plan)).toEqual({
        fromVersion: 3,
        toVersion: 3,
        applied: [],
      })
    }
  })
  test('missing steps, negative version, future schema and overlapping namespaces', async () => {
    const { storage, native } = setup()
    await expect(
      storage.migrate({ version: 2, steps: { 2: () => {} } })
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(
      storage.migrate({ version: -1, steps: {} })
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await storage.namespace('settings').migrate(plan)
    await expect(
      storage.namespace('settings').migrate({ version: 2, steps: {} })
    ).rejects.toMatchObject({ code: 'SCHEMA_TOO_NEW' })
    await expect(
      storage.migrate({ version: 1, steps: { 1: () => {} } })
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(
      storage
        .namespace('settings.editor')
        .migrate({ version: 1, steps: { 1: () => {} } })
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await storage
      .namespace('cache')
      .migrate({ version: 1, steps: { 1: (d) => d.set('lastTitle', 'ok') } })
    expect(native.data.local[META]).toEqual({ settings: 3, cache: 1 })
  })
  test('step failure leaves data/version untouched and records step/cause', async () => {
    const { native, storage } = setup()
    native.data.local['settings.theme'] = 'dark'
    await expect(
      storage.namespace('settings').migrate({
        version: 2,
        steps: {
          1: (d) => d.set('theme', 'light'),
          2: () => {
            throw Error('injected')
          },
        },
      })
    ).rejects.toMatchObject({
      code: 'MIGRATION_FAILED',
      details: { step: 2 },
      cause: expect.any(Error),
    })
    expect(native.data.local).toEqual({ 'settings.theme': 'dark' })
  })
  test('draft clone isolation, closed draft and public reentry', async () => {
    const { native, storage } = setup()
    native.data.local['settings.old'] = { x: 1 }
    let captured: import('../src/storage').MigrationDraft | undefined
    await expect(
      storage.namespace('settings').migrate({
        version: 1,
        steps: {
          1: async (d) => {
            captured = d
            const old = d.get('old') as { x: number }
            old.x = 2
            expect(d.get('old')).toEqual({ x: 1 })
            await storage.get('settings.theme')
          },
        },
      })
    ).rejects.toMatchObject({ code: 'MIGRATION_FAILED' })
    expect(() => captured!.set('theme', 'dark')).toThrow()
    expect(native.data.local['settings.old']).toEqual({ x: 1 })
  })
  test('two independent contexts serialize migrations and CRUD on the same area lock', async () => {
    const native = new StorageNative(),
      a = setup('local', native),
      b = setup('local', native)
    let release!: () => void, entered!: () => void
    const barrier = new Promise<void>((r) => {
        release = r
      }),
      started = new Promise<void>((r) => {
        entered = r
      })
    let steps = 0
    const migration = {
      version: 1,
      steps: {
        1: async (d: import('../src/storage').MigrationDraft) => {
          steps++
          entered()
          await barrier
          d.set('theme', 'light')
        },
      },
    }
    const first = a.storage.namespace('settings').migrate(migration)
    await started
    let read = false
    const get = b.storage.get('settings.theme').then((v) => {
      read = true
      return v
    })
    const second = b.storage.namespace('settings').migrate(migration)
    await new Promise((r) => setTimeout(r, 10))
    expect(read).toBe(false)
    release()
    await first
    expect(await get).toBe('light')
    expect((await second).applied).toEqual([])
    expect(steps).toBe(1)
  })
  for (const stage of [
    'journal',
    'data-set',
    'data-remove',
    'readback',
    'version',
    'cleanup',
  ] as const)
    test(`injected stop at ${stage}; next CRUD recovers without rerunning steps`, async () => {
      const { storage, native } = setup()
      native.data.local['settings.obsolete'] = 'old'
      let journalWritten = false,
        dataWritten = false,
        tripped = false,
        stepCalls = 0
      native.failure = (_area, method, arg) => {
        const obj = arg as Record<string, unknown>
        const isJournal = method === 'set' && Object.hasOwn(obj, JOURNAL)
        const isData = method === 'set' && Object.hasOwn(obj, 'settings.theme')
        const matches =
          stage === 'journal'
            ? isJournal
            : stage === 'data-set'
              ? isData
              : stage === 'data-remove'
                ? method === 'remove' && Array.isArray(arg)
                : stage === 'readback'
                  ? method === 'get' &&
                    dataWritten &&
                    Array.isArray(arg) &&
                    arg.includes('settings.theme')
                  : stage === 'version'
                    ? method === 'set' && Object.hasOwn(obj, META)
                    : method === 'remove' && arg === JOURNAL
        if (!tripped && matches) {
          tripped = true
          throw Error('injected stop')
        }
        if (isJournal) journalWritten = true
        if (isData) dataWritten = true
      }
      await expect(
        storage.namespace('settings').migrate({
          version: 1,
          steps: {
            1: (d) => {
              stepCalls++
              d.set('theme', 'light')
              d.remove('obsolete')
            },
          },
        })
      ).rejects.toMatchObject({ code: 'NATIVE_ERROR' })
      expect(tripped).toBe(true)
      native.failure = undefined
      expect(await storage.get('settings.theme')).toBe(
        journalWritten ? 'light' : undefined
      )
      expect(native.data.local[JOURNAL]).toBeUndefined()
      if (journalWritten)
        expect(native.data.local[META]).toEqual({ settings: 1 })
      else expect(native.data.local['settings.obsolete']).toBe('old')
      expect(stepCalls).toBe(1)
    })
  test('external conflicts preserve journal and do not overwrite another key', async () => {
    const { native, storage } = setup()
    native.failure = (_a, method, arg) => {
      if (method === 'set' && Object.hasOwn(arg as object, 'settings.theme'))
        throw Error('stop')
    }
    await expect(storage.namespace('settings').migrate(plan)).rejects.toThrow()
    native.failure = undefined
    native.data.local['settings.language'] = 'external'
    await expect(storage.get('settings.theme')).rejects.toMatchObject({
      code: 'MIGRATION_CONFLICT',
    })
    expect(native.data.local['settings.theme']).toBeUndefined()
    expect(native.data.local['settings.language']).toBe('external')
    expect(native.data.local[JOURNAL]).toBeDefined()
  })
  test('journal capacity failure never starts data mutation', async () => {
    const { native, storage } = setup()
    native.failure = (_a, method, arg) => {
      if (method === 'set' && Object.hasOwn(arg as object, JOURNAL))
        throw Error('QUOTA_BYTES exceeded')
    }
    await expect(
      storage.namespace('settings').migrate(plan)
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
    expect(native.data.local).toEqual({})
  })
  test('sync explicitly opts in, keeps journal local, and refuses simulated remote conflicts', async () => {
    const { native, storage } = setup('sync')
    await expect(
      storage.namespace('settings').migrate(plan)
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' })
    native.failure = (area, method, arg) => {
      if (
        area === 'sync' &&
        method === 'set' &&
        Object.hasOwn(arg as object, 'settings.theme')
      )
        throw Error('stop')
    }
    await expect(
      storage
        .namespace('settings')
        .migrate({ ...plan, allowNonAtomicSync: true })
    ).rejects.toThrow()
    expect(native.data.local[SYNC_JOURNAL]).toBeDefined()
    expect(native.data.sync[JOURNAL]).toBeUndefined()
    native.failure = undefined
    native.data.sync[META] = { settings: 5 }
    await expect(storage.get('settings.theme')).rejects.toMatchObject({
      code: 'MIGRATION_CONFLICT',
    })
    expect(native.data.local[SYNC_JOURNAL]).toBeDefined()
    delete native.data.sync[META]
    expect(await storage.get('settings.theme')).toBe('light')
    expect(native.data.local[SYNC_JOURNAL]).toBeUndefined()
    expect(native.data.sync[META]).toEqual({ settings: 3 })
  })
})

describe('storage recovery boundaries', () => {
  test('session migration recovers in a newly created context', async () => {
    const s = setup('session')
    s.native.failure = (area, method, arg) => {
      if (
        area === 'session' &&
        method === 'set' &&
        Object.hasOwn(arg as object, META)
      )
        throw Error('stopped before version')
    }
    await expect(
      s.storage.namespace('settings').migrate(plan)
    ).rejects.toMatchObject({ code: 'NATIVE_ERROR' })
    s.native.failure = undefined
    const fresh = setup('session', s.native)
    expect(await fresh.storage.get('settings.theme')).toBe('light')
    expect(s.native.data.session[META]).toEqual({ settings: 3 })
    expect(s.native.data.session[JOURNAL]).toBeUndefined()
  })
  test('committed journal verifies data and preserves a later external change', async () => {
    const s = setup()
    s.native.failure = (_area, method, arg) => {
      if (method === 'remove' && arg === JOURNAL)
        throw Error('stopped at cleanup')
    }
    await expect(
      s.storage.namespace('settings').migrate(plan)
    ).rejects.toThrow()
    s.native.failure = undefined
    s.native.data.local['settings.theme'] = 'external'
    await expect(s.storage.get('settings.theme')).rejects.toMatchObject({
      code: 'MIGRATION_CONFLICT',
    })
    expect(s.native.data.local['settings.theme']).toBe('external')
    expect(s.native.data.local[JOURNAL]).toBeDefined()
  })
  test('observed sync metadata change during readback prevents version commit', async () => {
    const s = setup('sync')
    let written = false,
      changed = false
    s.native.failure = (area, method, arg) => {
      if (
        area === 'sync' &&
        method === 'set' &&
        Object.hasOwn(arg as object, 'settings.theme')
      )
        written = true
      if (
        !changed &&
        area === 'sync' &&
        method === 'get' &&
        written &&
        Array.isArray(arg) &&
        arg.includes('settings.theme')
      ) {
        changed = true
        s.native.data.sync[META] = { settings: 10 }
      }
    }
    await expect(
      s.storage
        .namespace('settings')
        .migrate({ ...plan, allowNonAtomicSync: true })
    ).rejects.toMatchObject({ code: 'MIGRATION_CONFLICT' })
    expect(s.native.data.sync[META]).toEqual({ settings: 10 })
    expect(s.native.data.local[SYNC_JOURNAL]).toBeDefined()
  })
  test('corrupt journals and version metadata fail closed', async () => {
    const s = setup()
    s.native.data.local[JOURNAL] = {
      id: 'bad',
      prefix: 'settings',
      from: 0,
      to: 1,
      entries: [{ key: 'cache.lastTitle', after: 'wrong' }],
    }
    await expect(s.storage.get('settings.theme')).rejects.toMatchObject({
      code: 'MIGRATION_CONFLICT',
    })
    expect(s.native.data.local['cache.lastTitle']).toBeUndefined()
    delete s.native.data.local[JOURNAL]
    s.native.data.local[META] = { settings: -1 }
    await expect(
      s.storage.namespace('settings').migrate(plan)
    ).rejects.toMatchObject({ code: 'MIGRATION_CONFLICT' })
  })
})

describe('final review storage regressions', () => {
  test('selected watchAll keys exclude other schemas and legacy/nested keys; unselected keys are unknown', async () => {
    const { runtime, native } = setup()
    const themes = createStorage<{ 'settings.theme': string }>(
      {},
      () => runtime
    ).namespace('settings')
    const counts = createStorage<{ 'settings.count': number }>(
      {},
      () => runtime
    ).namespace('settings')
    const selected: unknown[] = [],
      all: unknown[] = []
    const stop = themes.watchAll(['theme'], (c) => selected.push(c))
    const stopAll = themes.watchAll((c) => all.push(c))
    await Promise.all([stop.ready, stopAll.ready])
    await counts.set('count', 42)
    native.emit(
      {
        'settings.legacy': { newValue: false },
        'settings.editor.size': { newValue: 16 },
        'settingsExtra.theme': { newValue: 'outside' },
      },
      'local'
    )
    await themes.set('theme', 'dark')
    expect(selected).toEqual([
      { key: 'theme', oldValue: undefined, newValue: 'dark' },
    ])
    expect(all.map((v) => (v as { key: string }).key)).toEqual([
      'count',
      'legacy',
      'editor.size',
      'theme',
    ])
    stop()
    stopAll()
    expect(native.onChanged.listeners.size).toBe(0)
  })
  for (const area of ['local', 'session'] as const) {
    test(`${area}: aggregate >1MiB no-op, edits, removals and large journal recovery`, async () => {
      const { runtime, native } = setup(area)
      const store = createStorage<{ a: string; b: string; c: string }>(
        { area },
        () => runtime
      )
      await store.set('a', 'a'.repeat(600000))
      await store.set('b', 'b'.repeat(600000))
      await store.migrate({ version: 1, steps: { 1: () => {} } })
      const before = structuredClone(native.data[area])
      let interrupted = false
      native.failure = (a, method, arg) => {
        if (
          a === area &&
          method === 'set' &&
          Object.hasOwn(arg as object, 'a') &&
          !interrupted
        ) {
          interrupted = true
          throw Error('injected stop')
        }
      }
      await expect(
        store.migrate({
          version: 2,
          steps: {
            2: (d) => {
              d.set('a', 'x'.repeat(600000))
              d.remove('b')
              d.set('c', 'c'.repeat(600000))
            },
          },
        })
      ).rejects.toMatchObject({ code: 'NATIVE_ERROR' })
      expect(JSON.stringify(native.data[area][JOURNAL]).length).toBeGreaterThan(
        1048576
      )
      expect(native.data[area].a).toBe(before.a)
      expect(native.data[area][META]).toEqual({ '': 1 })
      native.failure = undefined
      const fresh = setup(area, native)
      const recovered = createStorage<{ a: string; b: string; c: string }>(
        { area },
        () => fresh.runtime
      )
      expect((await recovered.get('a'))?.length).toBe(600000)
      expect((await recovered.get('a'))?.startsWith('x')).toBe(true)
      expect(await recovered.get('b')).toBeUndefined()
      expect((await recovered.get('c'))?.length).toBe(600000)
      expect(native.data[area][JOURNAL]).toBeUndefined()
      expect(native.data[area][META]).toEqual({ '': 2 })
    })
  }
  for (const policy of ['raised', 'unlimited', 'dynamic'] as const) {
    test(`migration respects ${policy} native local capacity`, async () => {
      const native = new StorageNative(),
        env = native.env()
      const value = env.value
      env.value = (...path) =>
        path.join('.') === 'storage.local.QUOTA_BYTES'
          ? policy === 'dynamic'
            ? undefined
            : policy === 'raised'
              ? 40000000
              : 10485760
          : value(...path)
      if (policy === 'unlimited') {
        const method = env.method
        env.method = (...path) =>
          path.join('.') === 'permissions.contains'
            ? async () => true
            : method(...path)
      }
      const runtime = new StorageRuntime(
        env,
        undefined,
        () => native.locks.manager
      )
      const store = createStorage<Record<string, string>>({}, () => runtime)
      const count = policy === 'raised' ? 12 : 19
      for (let i = 0; i < count; i++)
        await store.set(`key${i}`, 'a'.repeat(600000))
      await store.migrate({
        version: 1,
        steps: {
          1: (d) => {
            if (policy === 'raised')
              for (let i = 0; i < count; i++)
                d.set(`key${i}`, 'b'.repeat(600000))
          },
        },
      })
      expect(native.data.local[META]).toEqual({ '': 1 })
      expect(await store.get('key0')).toBe(
        (policy === 'raised' ? 'b' : 'a').repeat(600000)
      )
    })
  }
  test('migration preflights intermediate data plus journal quota before any persistent write', async () => {
    const { runtime, native } = setup()
    const store = createStorage<Record<string, string>>({}, () => runtime)
    for (let i = 0; i < 9; i++) await store.set(`key${i}`, 'a'.repeat(600000))
    const snapshot = structuredClone(native.data.local),
      calls = native.calls.length
    await expect(
      store.migrate({
        version: 1,
        steps: {
          1: (d) => {
            for (let i = 0; i < 9; i++) d.set(`key${i}`, 'b'.repeat(600000))
          },
        },
      })
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
    expect(native.data.local).toEqual(snapshot)
    expect(native.calls.slice(calls).some((c) => c.method !== 'get')).toBe(
      false
    )
    await expect(
      store.set('tooLarge', 'x'.repeat(1048577))
    ).rejects.toMatchObject({ code: 'SERIALIZATION_ERROR' })
  })
})
