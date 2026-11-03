import type { WebextError } from '../internal/errors'
import type { JsonValue } from '../internal/json'
import type { Subscription, Unsubscribe } from '../internal/types'
import type { PageBridge, PageBridgeLimits } from '../messaging/types'

/**
 * 保存先の領域です。
 *
 * - `local`: 端末内に保存（既定）
 * - `sync`: ブラウザの同期機能でアカウント間に同期（容量が小さい）
 * - `session`: ブラウザを閉じると消える
 */
export type StorageArea = 'local' | 'sync' | 'session'

/**
 * ストレージのスキーマです。キーは保存キー（ドット区切りで階層化）、値は保存する JSON 値の型です。
 *
 * @example
 * ```ts
 * type Schema = {
 *   'settings.theme': 'light' | 'dark'
 *   'settings.fontSize': number
 * }
 * ```
 */
export type StorageSchema = { [key: string]: JsonValue }

/** スキーマのキー（文字列）です。 */
export type StorageKey<S> = keyof S & string

/** `'a.b.c'` から `'a'` / `'a.b'` を取り出します（namespace に使えるプレフィックス）。 */
export type StoragePrefix<K extends string> = K extends `${infer H}.${infer T}`
  ? H | `${H}.${StoragePrefix<T>}`
  : never

/** プレフィックス `P` 配下のキーからプレフィックスを除いたスキーマです。 */
export type StorageNamespace<S, P extends string> = {
  [K in keyof S as K extends `${P}.${infer Tail}` ? Tail : never]: S[K]
}

/** 型付きの変更通知です。`key` で絞り込むと値の型も絞り込まれます。 */
export type StorageChange<S> = {
  [K in StorageKey<S>]: {
    readonly key: K
    /** 変更前の値です。未保存なら `undefined` です。 */
    readonly oldValue: S[K] | undefined
    /** 変更後の値です。削除されたら `undefined` です。 */
    readonly newValue: S[K] | undefined
  }
}[StorageKey<S>]

/** キーを指定しない `watchAll` の変更通知です。値は検証されていないため `unknown` です。 */
export interface UnknownStorageChange {
  readonly key: string
  readonly oldValue: unknown
  readonly newValue: unknown
}

/** `watch` / `watchAll` のオプションです。 */
export interface StorageWatchOptions {
  /**
   * 購読の登録・再登録に失敗したときに呼ばれます。失敗した購読は停止します。
   */
  onError?(error: WebextError): void
}

/**
 * 変更の監視です。呼び出すと解除します。`ready` は登録完了で解決します。
 *
 * @example
 * ```ts
 * const subscription = storage.watch('theme', ({ newValue }) => apply(newValue))
 * await subscription.ready
 * subscription()
 * ```
 */
export type StorageSubscription = Subscription

/**
 * キーごとの値の validator です（型ガード関数）。
 *
 * 読み込み・書き込み・変更通知の値を検査します。`false` を返すか例外を投げると、
 * 読み書きは `VALIDATION_ERROR` になり、変更通知は配信されません。
 */
export type StorageValidators<S> = {
  [K in keyof S]?: (value: unknown) => value is S[K]
}

/** `webextStorage()` のオプションです。 */
export interface StorageOptions<S> {
  /**
   * 保存先の領域です。
   *
   * @default 'local'
   */
  area?: StorageArea
  /**
   * MAIN world で使う場合に、ISOLATED world が設置したブリッジのチャネルを指定します。
   * 読み書きできるのは ISOLATED world で `exposeToPage` により公開したキーだけです。
   */
  bridge?: { channel: string; limits?: PageBridgeLimits }
  /**
   * キー（namespace を含む完全なキー）ごとの validator です。
   *
   * 型はコンパイル時だけのものなので、古いデータや他のコードが書いた値を確実に扱うには validator を指定してください。
   */
  validate?: StorageValidators<S>
}

/** 移行ステップに渡される下書きです。namespace 内のキーを読み書きします。 */
export interface MigrationDraft {
  /** 値を読みます（コピー）。未保存なら `undefined` です。 */
  get(key: string): unknown
  /** 値を書きます。 */
  set(key: string, value: JsonValue): void
  /** 値を削除します。 */
  remove(key: string): void
}

/** 移行ステップです。下書きを変更します。同期・非同期どちらも可。 */
export type MigrationStep = (draft: MigrationDraft) => void | Promise<void>

/**
 * 移行計画です。
 *
 * @example
 * ```ts
 * await storage.migrate({
 *   version: 2,
 *   steps: {
 *     1: (draft) => draft.set('theme', 'light'),
 *     2: (draft) => draft.remove('legacy'),
 *   },
 * })
 * ```
 */
export interface MigrationPlan {
  /** 目標のバージョン（0 以上の整数）です。 */
  version: number
  /** `steps[n]` はバージョン `n - 1` から `n` への変更です。 */
  steps: Readonly<Record<number, MigrationStep>>
  /**
   * `sync` 領域の移行で `true` が必要です。sync は端末をまたいで原子的に更新できないことへの同意です。
   */
  allowNonAtomicSync?: boolean
}

/** 移行の結果です。 */
export interface MigrationResult {
  /** 移行前のバージョンです。 */
  readonly fromVersion: number
  /** 移行後のバージョンです。 */
  readonly toVersion: number
  /** 今回実行したステップ番号です。 */
  readonly applied: readonly number[]
}

/**
 * MAIN world に公開するキーと操作です。
 *
 * - `read`: 読み込みを許可するキー
 * - `write`: 書き込み・削除を許可するキー
 * - `watch`: 変更通知を許可するキー（`read` も必要）
 * - `validate`: 公開するすべてのキーの validator（必須）
 */
export interface PageStoragePolicy<S> {
  read?: readonly StorageKey<S>[]
  write?: readonly StorageKey<S>[]
  watch?: readonly StorageKey<S>[]
  validate: { [K in StorageKey<S>]?: (value: unknown) => value is S[K] }
}

/**
 * 型付きのストレージクライアントです。`webextStorage()` で作成します。
 *
 * @typeParam S スキーマ（{@link StorageSchema}）
 */
export interface StorageClient<S> {
  /**
   * 値を読みます。
   *
   * @returns 未保存なら `undefined`
   *
   * @example
   * ```ts
   * const theme = await storage.get('settings.theme')
   * ```
   */
  get<K extends StorageKey<S>>(key: K): Promise<S[K] | undefined>
  /**
   * 複数の値を読みます。結果は指定したすべてのキーを持ちます（未保存は `undefined`）。
   *
   * @example
   * ```ts
   * const { theme, fontSize } = await settings.getMany(['theme', 'fontSize'])
   * ```
   */
  getMany<const K extends readonly StorageKey<S>[]>(
    keys: K
  ): Promise<{ [P in K[number]]: S[P] | undefined }>
  /** 値を保存します。JSON 互換の値だけを保存できます。 */
  set<K extends StorageKey<S>>(key: K, value: S[K]): Promise<void>
  /** 複数の値をまとめて保存します。すべての値を検査してから書き込みます。 */
  setMany<const V extends Partial<S>>(
    values: V & Record<Exclude<keyof V, keyof S>, never>
  ): Promise<void>
  /** 値を削除します。未保存でも成功します。 */
  remove<K extends StorageKey<S>>(key: K): Promise<void>
  /** 複数の値を削除します。 */
  removeMany(keys: readonly StorageKey<S>[]): Promise<void>
  /**
   * プレフィックス配下のキーを扱うクライアントを返します。保存されるキーは変わりません。
   *
   * @example
   * ```ts
   * const settings = storage.namespace('settings')
   * await settings.set('theme', 'dark') // 'settings.theme' に保存
   * ```
   */
  namespace<P extends StoragePrefix<StorageKey<S>>>(
    prefix: P
  ): StorageClient<StorageNamespace<S, P>>
  /**
   * キーの変更を監視します。登録時点の値では呼ばれません。
   *
   * @example
   * ```ts
   * const stop = storage.watch('settings.theme', ({ oldValue, newValue }) => {
   *   console.log(oldValue, '→', newValue)
   * })
   * ```
   */
  watch<K extends StorageKey<S>>(
    key: K,
    callback: (change: {
      readonly oldValue: S[K] | undefined
      readonly newValue: S[K] | undefined
    }) => void,
    options?: StorageWatchOptions
  ): StorageSubscription
  /**
   * 指定した複数のキーの変更を監視します。通知の `key` で値の型を絞り込めます。
   */
  watchAll<const K extends readonly StorageKey<S>[]>(
    keys: K,
    callback: (change: StorageChange<Pick<S, K[number]>>) => void,
    options?: StorageWatchOptions
  ): StorageSubscription
  /**
   * namespace 内のすべてのキーの変更を監視します。スキーマ外のキーも届くため値は `unknown` です。
   */
  watchAll(
    callback: (change: UnknownStorageChange) => void,
    options?: StorageWatchOptions
  ): StorageSubscription
  /**
   * namespace のデータをバージョン付きで移行します。Background と拡張機能ページでだけ使えます。
   *
   * 詳しくは `docs/storage.md` の「データの移行」を参照してください。
   */
  migrate(plan: MigrationPlan): Promise<MigrationResult>
  /**
   * ISOLATED world で、キーを MAIN world に公開します。
   *
   * @param bridge `messaging.installPageBridge()` で設置したブリッジ
   * @returns 公開を取り消す関数
   */
  exposeToPage(bridge: PageBridge, policy: PageStoragePolicy<S>): Unsubscribe
}

/** `webextStorage.startBackground()` のオプションです。 */
export interface StorageBackgroundOptions {
  /**
   * Content Script からアクセスできる領域です。
   *
   * @default { local: true, sync: true, session: false }
   */
  contentScriptAccess?: Partial<Record<StorageArea, boolean>>
}
