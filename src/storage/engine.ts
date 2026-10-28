import type { JsonValue } from '../internal/json'
import type {
  MigrationDraft,
  MigrationPlan,
  MigrationResult,
  StorageArea,
} from './types'

import { WebextError } from '../internal/errors'
import { object } from '../internal/native'
import { Environment } from '../messaging/environment'
import {
  JOURNAL,
  META,
  SYNC_JOURNAL,
  clone,
  equal,
  fail,
  key,
  within,
} from './common'

type Versions = Record<string, number>
type Entry = { key: string; before?: JsonValue; after?: JsonValue }
type Journal = {
  id: string
  prefix: string
  from: number
  to: number
  entries: Entry[]
}
const quota = /quota|QUOTA|MAX_WRITE|MAX_ITEMS|exceed.*(?:bytes|storage)/i
const permission = /permission|access denied|not allowed/i
export class StorageEngine {
  private migrating = new Set<StorageArea>()
  constructor(
    readonly env = new Environment(),
    readonly locks: () => LockManager | undefined = () =>
      globalThis.navigator?.locks
  ) {}
  async call(
    area: StorageArea,
    method: string,
    ...args: unknown[]
  ): Promise<unknown> {
    const fn = this.env.method('storage', area, method)
    if (!fn)
      throw fail(
        area === 'session' ? 'UNSUPPORTED_OPERATION' : 'PERMISSION_DENIED',
        `Storage ${area}.${method} is unavailable`
      )
    try {
      return await fn(...args)
    } catch (cause) {
      if (cause instanceof WebextError) throw cause
      const message = cause instanceof Error ? cause.message : String(cause)
      throw fail(
        quota.test(message)
          ? 'QUOTA_EXCEEDED'
          : permission.test(message)
            ? 'PERMISSION_DENIED'
            : 'NATIVE_ERROR',
        `Storage ${area}.${method} failed`,
        cause
      )
    }
  }
  async read(
    area: StorageArea,
    names: string[] | null
  ): Promise<Record<string, unknown>> {
    const value = object(await this.call(area, 'get', names))
    if (!value) throw fail('NATIVE_ERROR', 'Invalid native storage response')
    // Native storage returns ordinary objects; absent keys must not resolve to
    // Object.prototype members such as toString or valueOf.
    return Object.assign(Object.create(null), value)
  }
  async locked<T>(
    area: StorageArea,
    task: () => Promise<T>,
    external = false
  ): Promise<T> {
    if (!external && this.migrating.has(area))
      throw fail(
        'MIGRATION_FAILED',
        'Public storage reentry during a migration is forbidden'
      )
    const locks = this.locks()
    if (!locks || typeof locks.request !== 'function')
      throw fail(
        'UNSUPPORTED_OPERATION',
        'Storage coordination requires Web Locks'
      )
    let entered = false
    try {
      return await locks.request(
        `__webext_utils__storage_v1_${area}`,
        async () => {
          entered = true
          await this.recover(area)
          return await task()
        }
      )
    } catch (cause) {
      if (cause instanceof WebextError) throw cause
      throw fail(
        entered ? 'NATIVE_ERROR' : 'UNSUPPORTED_OPERATION',
        'Storage Web Lock failed',
        cause
      )
    }
  }

  private async versions(area: StorageArea): Promise<Versions> {
    const raw = (await this.read(area, [META]))[META]
    if (raw === undefined) return Object.create(null) as Versions
    const v = object(raw)
    if (
      !v ||
      Object.entries(v).some(
        ([p, n]) =>
          (p !== '' &&
            (() => {
              try {
                key(p)
                return false
              } catch {
                return true
              }
            })()) ||
          !Number.isSafeInteger(n) ||
          (n as number) < 0
      )
    )
      throw fail('MIGRATION_CONFLICT', 'Invalid storage version metadata')
    return Object.assign(Object.create(null), v) as Versions
  }
  private journalLocation(area: StorageArea): [StorageArea, string] {
    return area === 'sync' ? ['local', SYNC_JOURNAL] : [area, JOURNAL]
  }
  private async recover(area: StorageArea): Promise<void> {
    const [journalArea, journalKey] = this.journalLocation(area)
    const raw = (await this.read(journalArea, [journalKey]))[journalKey]
    if (raw === undefined) return
    const j = object(raw)
    if (
      !j ||
      typeof j.id !== 'string' ||
      typeof j.prefix !== 'string' ||
      !Number.isSafeInteger(j.from) ||
      !Number.isSafeInteger(j.to) ||
      (j.from as number) < 0 ||
      (j.to as number) <= (j.from as number) ||
      !Array.isArray(j.entries)
    )
      throw fail('MIGRATION_CONFLICT', 'Invalid storage migration journal')
    const journal = j as unknown as Journal
    if (journal.prefix) key(journal.prefix)
    const seen = new Set<string>()
    for (const e of journal.entries) {
      if (!object(e)) throw fail('MIGRATION_CONFLICT', 'Invalid journal entry')
      key(e.key)
      if (!within(e.key, journal.prefix) || seen.has(e.key))
        throw fail(
          'MIGRATION_CONFLICT',
          'Journal key outside migration namespace'
        )
      seen.add(e.key)
      if (Object.hasOwn(e, 'before')) clone(e.before)
      if (Object.hasOwn(e, 'after')) clone(e.after)
    }
    const versions = await this.versions(area)
    const version = versions[journal.prefix] ?? 0
    if (version !== journal.from && version !== journal.to)
      throw fail('MIGRATION_CONFLICT', 'Migration version changed externally')
    const current = await this.read(area, [...seen])
    for (const e of journal.entries) {
      if (
        !equal(current[e.key], e.after) &&
        (version === journal.to || !equal(current[e.key], e.before))
      )
        throw fail(
          'MIGRATION_CONFLICT',
          `Migration data changed externally: ${e.key}`
        )
    }
    if (version !== journal.to) {
      const values = Object.fromEntries(
        journal.entries
          .filter((e) => Object.hasOwn(e, 'after'))
          .map((e) => [e.key, e.after])
      )
      const removed = journal.entries
        .filter((e) => !Object.hasOwn(e, 'after'))
        .map((e) => e.key)
      if (Object.keys(values).length) await this.call(area, 'set', values)
      if (removed.length) await this.call(area, 'remove', removed)
      const verify = await this.read(area, [...seen])
      if (journal.entries.some((e) => !equal(verify[e.key], e.after)))
        throw fail('MIGRATION_CONFLICT', 'Migration readback failed')
      // Sync and direct native writers do not participate in our lock. Re-read
      // metadata before committing so an observed remote version is never lost.
      const finalVersions = await this.versions(area)
      const finalVersion = finalVersions[journal.prefix] ?? 0
      if (finalVersion !== journal.from && finalVersion !== journal.to)
        throw fail(
          'MIGRATION_CONFLICT',
          'Migration version changed before commit'
        )
      finalVersions[journal.prefix] = journal.to
      await this.call(area, 'set', { [META]: finalVersions })
    }
    await this.call(journalArea, 'remove', journalKey)
  }
  async migrate(
    area: StorageArea,
    prefix: string,
    plan: MigrationPlan
  ): Promise<MigrationResult> {
    if (
      !plan ||
      !Number.isSafeInteger(plan.version) ||
      plan.version < 0 ||
      !object(plan.steps)
    )
      throw fail('INVALID_ARGUMENT', 'Invalid migration plan')
    if (area === 'sync' && plan.allowNonAtomicSync !== true)
      throw fail(
        'UNSUPPORTED_OPERATION',
        'Sync migration requires allowNonAtomicSync: true'
      )
    const steps = { ...plan.steps },
      target = plan.version
    return await this.locked(area, async () => {
      const versions = await this.versions(area)
      for (const registered of Object.keys(versions))
        if (
          registered !== prefix &&
          (!registered ||
            !prefix ||
            within(registered, prefix) ||
            within(prefix, registered))
        )
          throw fail('INVALID_ARGUMENT', 'Overlapping migration namespaces')
      const from = versions[prefix] ?? 0
      if (from > target)
        throw fail(
          'SCHEMA_TOO_NEW',
          'Stored schema is newer than this migration plan'
        )
      for (let n = from + 1; n <= target; n++)
        if (typeof steps[n] !== 'function')
          throw fail('INVALID_ARGUMENT', `Missing migration step ${n}`)
      if (from === target)
        return { fromVersion: from, toVersion: target, applied: [] }
      const snapshot = await this.read(area, null)
      const original: Record<string, unknown> = Object.create(null)
      // The JSON bound applies to a value, never to an entire native area.
      const draft: Record<string, JsonValue> = Object.create(null)
      for (const [k, v] of Object.entries(snapshot)) {
        if (k.startsWith('__webext_utils') || !within(k, prefix)) continue
        original[k] = v
        draft[k] = clone(v) as JsonValue
      }
      const full = (relative: string) => {
        key(relative)
        return prefix ? `${prefix}.${relative}` : relative
      }
      let live = true
      const active = () => {
        if (!live) throw fail('MIGRATION_FAILED', 'Migration draft is closed')
      }
      const api: MigrationDraft = {
        get: (k) => {
          active()
          const v = draft[full(k)]
          return v === undefined ? undefined : clone(v)
        },
        set: (k, v) => {
          active()
          draft[full(k)] = clone(v)
        },
        remove: (k) => {
          active()
          delete draft[full(k)]
        },
      }
      const applied: number[] = []
      this.migrating.add(area)
      try {
        for (let n = from + 1; n <= target; n++) {
          try {
            await steps[n]!(api)
            applied.push(n)
          } catch (cause) {
            throw new WebextError(
              'MIGRATION_FAILED',
              'storage.migrate',
              `Migration step ${n} failed`,
              { cause, details: { step: n } }
            )
          }
        }
      } finally {
        live = false
        this.migrating.delete(area)
      }
      const entries: Entry[] = []
      for (const k of new Set([
        ...Object.keys(original),
        ...Object.keys(draft),
      ])) {
        if (equal(original[k], draft[k])) continue
        entries.push({
          key: k,
          ...(original[k] === undefined
            ? {}
            : { before: original[k] as JsonValue }),
          ...(draft[k] === undefined ? {} : { after: draft[k] }),
        })
      }
      const journal: Journal = {
        id: crypto.randomUUID(),
        prefix,
        from,
        to: target,
        entries,
      }
      const [journalArea, journalKey] = this.journalLocation(area)
      // Check the journal and every intermediate write before changing data.
      const journalSnapshot =
        journalArea === area ? snapshot : await this.read(journalArea, null)
      const unlimitedLocal =
        (area === 'local' || journalArea === 'local') &&
        !!this.env.method('permissions', 'contains') &&
        (await this.env.call(['permissions', 'contains'], {
          permissions: ['unlimitedStorage'],
        })) === true
      const staged = { ...journalSnapshot, [journalKey]: journal }
      this.checkQuota(journalArea, staged, unlimitedLocal)
      const updated = {
        ...(journalArea === area ? staged : snapshot),
        ...draft,
      }
      // recover() writes updated values before deleting old keys, then metadata.
      this.checkQuota(area, updated, unlimitedLocal)
      for (const k of Object.keys(original))
        if (!Object.hasOwn(draft, k)) delete updated[k]
      this.checkQuota(
        area,
        {
          ...updated,
          [META]: { ...versions, [prefix]: target },
        },
        unlimitedLocal
      )
      await this.call(journalArea, 'set', { [journalKey]: journal })
      await this.recover(area)
      return { fromVersion: from, toVersion: target, applied }
    })
  }
  private checkQuota(
    area: StorageArea,
    values: Record<string, unknown>,
    unlimitedLocal: boolean
  ): void {
    const bytes = (value: unknown) =>
      new TextEncoder().encode(JSON.stringify(value)).byteLength
    const entries = Object.entries(values)
    const sizes = entries.map(
      ([k, v]) => new TextEncoder().encode(k).byteLength + bytes(v)
    )
    // Prefer the native constants, including raised quotas where provided.
    const total = this.env.value('storage', area, 'QUOTA_BYTES')
    // Firefox local uses a dynamic disk quota, not Chrome's fixed local cap.
    // Unknown/disk quotas and unlimitedStorage still use the native check.
    const limit =
      area === 'local' && unlimitedLocal
        ? Infinity
        : typeof total === 'number'
          ? total
          : area === 'sync'
            ? 102400
            : area === 'session'
              ? 10485760
              : Infinity
    const perItem = this.env.value('storage', area, 'QUOTA_BYTES_PER_ITEM')
    const maxItems = this.env.value('storage', area, 'MAX_ITEMS')
    if (
      sizes.reduce((a, b) => a + b, 0) > limit ||
      (area === 'sync' &&
        (sizes.some(
          (n) => n > (typeof perItem === 'number' ? perItem : 8192)
        ) ||
          entries.length > (typeof maxItems === 'number' ? maxItems : 512)))
    )
      throw fail(
        'QUOTA_EXCEEDED',
        'Migration data and recovery journal exceed native capacity'
      )
  }
}
