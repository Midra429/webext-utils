import type { Unsubscribe } from '../internal/errors'
import type { JsonValue } from '../internal/json'
import type {
  StorageBackgroundOptions,
  StorageClient,
  StorageOptions,
} from './types'

import { createStorage, current } from './client'

export type { ErrorCode, Unsubscribe } from '../internal/errors'
export type { JsonValue } from '../internal/json'
export type {
  MigrationDraft,
  MigrationPlan,
  MigrationResult,
  PageStoragePolicy,
  StorageArea,
  StorageBackgroundOptions,
  StorageChange,
  StorageClient,
  StorageOptions,
  StorageSubscription,
  StorageValidators,
  StorageWatchOptions,
  UnknownStorageChange,
} from './types'

export { WebextError, isWebextError } from '../internal/errors'

function create<S extends { [K in keyof S]: JsonValue }>(
  options?: StorageOptions<S>
): StorageClient<S> {
  return createStorage(options)
}
export const webextStorage = Object.assign(create, {
  startBackground(options?: StorageBackgroundOptions): Unsubscribe {
    return current().startBackground(options)
  },
})
