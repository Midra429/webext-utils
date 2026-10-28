import type { Unsubscribe, WebextError } from '../internal/errors'
import type { JsonValue } from '../internal/json'
import type { PageBridge, PageBridgeLimits } from '../messaging/types'

export type StorageArea = 'local' | 'sync' | 'session'
type Key<S> = keyof S & string
type Prefix<K extends string> = K extends `${infer H}.${infer T}`
  ? H | `${H}.${Prefix<T>}`
  : never
type Slice<S, P extends string> = {
  [K in keyof S as K extends `${P}.${infer Tail}` ? Tail : never]: S[K]
}
export type StorageChange<S> = {
  [K in Key<S>]: {
    key: K
    oldValue: S[K] | undefined
    newValue: S[K] | undefined
  }
}[Key<S>]
export type UnknownStorageChange = {
  key: string
  oldValue: unknown
  newValue: unknown
}
export interface StorageWatchOptions {
  /** Includes initial registration and later re-registration failures. */
  onError?(error: WebextError): void
}
export interface StorageSubscription {
  (): void
  readonly ready: Promise<void>
}
export type StorageValidators<S> = { [K in keyof S]?: (value: unknown) => S[K] }
export interface StorageOptions<S> {
  area?: StorageArea
  bridge?: { channel: string; limits?: PageBridgeLimits }
  validate?: StorageValidators<S>
}
export interface MigrationDraft {
  get(key: string): unknown
  set(key: string, value: JsonValue): void
  remove(key: string): void
}
export interface MigrationPlan {
  version: number
  steps: Readonly<
    Record<number, (draft: MigrationDraft) => void | Promise<void>>
  >
  allowNonAtomicSync?: boolean
}
export interface MigrationResult {
  fromVersion: number
  toVersion: number
  applied: number[]
}
export interface PageStoragePolicy<S> {
  read?: readonly Key<S>[]
  write?: readonly Key<S>[]
  watch?: readonly Key<S>[]
  validate: { [K in Key<S>]?: (value: unknown) => value is S[K] }
}
export interface StorageClient<S> {
  get<K extends Key<S>>(key: K): Promise<S[K] | undefined>
  getMany<const K extends readonly Key<S>[]>(
    keys: K
  ): Promise<{ [P in K[number]]: S[P] | undefined }>
  set<K extends Key<S>>(key: K, value: S[K]): Promise<void>
  setMany<const V extends Partial<S>>(
    values: V & Record<Exclude<keyof V, keyof S>, never>
  ): Promise<void>
  remove<K extends Key<S>>(key: K): Promise<void>
  removeMany(keys: readonly Key<S>[]): Promise<void>
  namespace<P extends Prefix<Key<S>>>(prefix: P): StorageClient<Slice<S, P>>
  watch<K extends Key<S>>(
    key: K,
    callback: (change: {
      oldValue: S[K] | undefined
      newValue: S[K] | undefined
    }) => void,
    options?: StorageWatchOptions
  ): StorageSubscription
  watchAll<const K extends readonly Key<S>[]>(
    keys: K,
    callback: (change: StorageChange<Pick<S, K[number]>>) => void,
    options?: StorageWatchOptions
  ): StorageSubscription
  watchAll(
    callback: (change: UnknownStorageChange) => void,
    options?: StorageWatchOptions
  ): StorageSubscription
  migrate(plan: MigrationPlan): Promise<MigrationResult>
  exposeToPage(bridge: PageBridge, policy: PageStoragePolicy<S>): Unsubscribe
}
export interface StorageBackgroundOptions {
  contentScriptAccess?: Partial<Record<StorageArea, boolean>>
}
