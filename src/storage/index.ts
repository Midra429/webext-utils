/**
 * 型付きのストレージ（`storage.local` / `sync` / `session`）を扱うモジュールです。
 *
 * @module
 */
import type { JsonValue } from '../internal/json'
import type { Unsubscribe } from '../internal/types'
import type {
  StorageBackgroundOptions,
  StorageClient,
  StorageOptions,
} from './types'

import { createStorage, current } from './client'

export type { ErrorCode, WebextErrorOptions } from '../internal/errors'
export type { JsonValue } from '../internal/json'
export type { Subscription, Unsubscribe } from '../internal/types'
export type {
  MigrationDraft,
  MigrationPlan,
  MigrationResult,
  MigrationStep,
  PageStoragePolicy,
  StorageArea,
  StorageBackgroundOptions,
  StorageChange,
  StorageClient,
  StorageKey,
  StorageNamespace,
  StorageOptions,
  StoragePrefix,
  StorageSchema,
  StorageSubscription,
  StorageValidators,
  StorageWatchOptions,
  UnknownStorageChange,
} from './types'

export { WebextError, isWebextError } from '../internal/errors'

/**
 * 型付きのストレージクライアントを作成します。
 *
 * 作成するだけではブラウザ API に触れません。Manifest に `"permissions": ["storage"]` が必要です。
 *
 * @typeParam S スキーマ。キーは保存キー（ドット区切り）、値は JSON 互換の型
 * @param options 保存先の領域・validator など
 *
 * @example
 * ```ts
 * import { webextStorage } from '@midra/webext-utils/storage'
 *
 * const storage = webextStorage<{
 *   'settings.theme': 'light' | 'dark'
 *   'settings.fontSize': number
 * }>()
 *
 * await storage.set('settings.theme', 'dark')
 * const theme = await storage.get('settings.theme') // 'light' | 'dark' | undefined
 * ```
 */
function create<S extends { [K in keyof S]: JsonValue }>(
  options?: StorageOptions<S>
): StorageClient<S> {
  return createStorage(options)
}

/**
 * Background で、Content Script からのストレージ操作を受け付けます。
 *
 * Content Script（または MAIN world）からストレージを使う場合に必要です。
 * Background のスクリプトの最上位で、`webextMessaging.startBackground()` の後、
 * 最初の `await` より前に呼び出してください。
 *
 * @returns 登録を解除する関数
 *
 * @example
 * ```ts
 * webextMessaging.startBackground()
 * webextStorage.startBackground({ contentScriptAccess: { session: true } })
 * ```
 */
function startBackground(options?: StorageBackgroundOptions): Unsubscribe {
  return current().startBackground(options)
}

/**
 * 型付きのストレージクライアントを作成する関数です。
 *
 * `webextStorage<Schema>(options?)` でクライアントを作成し、
 * `webextStorage.startBackground()` で Background の受付を開始します。
 */
export const webextStorage: typeof create & {
  startBackground: typeof startBackground
} = Object.assign(create, { startBackground })
