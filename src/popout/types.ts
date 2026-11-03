import type { WebextError } from '../internal/errors'
import type { ContentScriptTarget } from '../messaging/types'

/** popout の元になる UI です。 */
export type PopoutSource = 'popup' | 'side-panel'

/**
 * ポップアップのページ設定をどのタブ（ウィンドウ）から読むかを指定します。
 *
 * `windowId` を指定した場合は、そのウィンドウのアクティブなタブの設定を使います。
 */
export type PopoutSourceTarget =
  | { readonly tabId: number; readonly windowId?: never }
  | { readonly windowId: number; readonly tabId?: never }

/** {@link PopoutOptions} の共通項目です。 */
export interface PopoutBaseOptions {
  /**
   * 開くページです。拡張機能のルートからの相対パス、または絶対 URL で指定します。
   *
   * 省略すると `source` の UI に現在設定されているページを使います。
   */
  page?: string
  /**
   * popout に関連付けるタブの ID です。
   *
   * 指定すると、ハンドルの `getTab()` / `activateTab()` / `messageTarget()` でこのタブを操作できます。
   * 関連付けは固定で、アクティブなタブには追従しません。
   */
  associatedTabId?: number
  /** ウィンドウの幅（px）です。@default 480 */
  width?: number
  /** ウィンドウの高さ（px）です。@default 720 */
  height?: number
  /** ウィンドウの左端の位置（px）です。省略時はブラウザが決めます。 */
  left?: number
  /** ウィンドウの上端の位置（px）です。省略時はブラウザが決めます。 */
  top?: number
  /** 開いたウィンドウにフォーカスするかです。@default true */
  focused?: boolean
  /**
   * 再利用キーです。同じキーの popout が既に開いていれば、新しく開かずにそのウィンドウへフォーカスします。
   *
   * 同じキーで `source`・ページ・関連タブが異なる場合は `INVALID_ARGUMENT` です。
   */
  reuseKey?: string
}

/** ポップアップ（`action.default_popup`）を元にする popout のオプションです。 */
export interface PopupPopoutOptions extends PopoutBaseOptions {
  source: 'popup'
  /** ページ設定を読むタブ（ウィンドウ）です。省略時は全体の設定を使います。 */
  sourceTarget?: PopoutSourceTarget
  /**
   * `true` にすると、popout を開いた後に呼び出し元のポップアップを閉じます。
   *
   * 結果はハンドルの `originalUiClose` で確認できます。
   * @default false
   */
  closeOriginal?: boolean
}

/** サイドパネルを元にする popout のオプションです。 */
export interface SidePanelPopoutOptions extends PopoutBaseOptions {
  source: 'side-panel'
  sourceTarget?: never
  /**
   * サイドパネルは popout を開いた後に閉じられないため（ブラウザがユーザー操作を要求するため）、指定できません。
   * 閉じる場合は、ユーザー操作の処理内で `webextSidePanel.close()` を呼び出してください。
   */
  closeOriginal?: never
}

/**
 * `webextPopout.open()` のオプションです。`source` で元にする UI を指定します。
 *
 * @example
 * ```ts
 * await webextPopout.open({ source: 'popup', reuseKey: 'main' })
 * await webextPopout.open({ source: 'side-panel', associatedTabId: 42 })
 * ```
 */
export type PopoutOptions = PopupPopoutOptions | SidePanelPopoutOptions

/** popout ウィンドウの位置と大きさです（ブラウザが実際に適用した値）。 */
export interface PopoutBounds {
  readonly width?: number
  readonly height?: number
  readonly left?: number
  readonly top?: number
}

/**
 * popout に関連付けたタブの情報です。
 *
 * `url` / `title` / `favIconUrl` は Manifest の `tabs` 権限または対象サイトのホスト権限がある場合だけ含まれます。
 */
export interface PopoutTab {
  readonly id: number
  readonly windowId: number
  readonly index: number
  readonly active: boolean
  readonly pinned: boolean
  readonly url?: string
  readonly title?: string
  readonly favIconUrl?: string
}

/**
 * `closeOriginal` の結果です。
 *
 * - `not-requested`: 要求していない
 * - `closed`: 元のポップアップを閉じた
 * - `unsupported`: 呼び出し元がポップアップではないため閉じなかった
 * - `failed`: 閉じる処理が失敗した（`error` を参照）。popout 自体は開いています
 */
export type OriginalUiClose =
  | { readonly status: 'not-requested' | 'closed' | 'unsupported' }
  | { readonly status: 'failed'; readonly error: WebextError }

/** {@link PopoutHandle.messageTarget} のオプションです。 */
export interface PopoutMessageTargetOptions {
  /** 宛先のフレーム ID です。@default 0 */
  frameId?: number
  /** 宛先の文書 ID です。 */
  documentId?: string
  /** 宛先の Content Script のワールドです。@default 'ISOLATED' */
  world?: 'ISOLATED' | 'MAIN'
}

/**
 * 開いた popout ウィンドウを操作するハンドルです。
 *
 * @example
 * ```ts
 * const popout = await webextPopout.open({ source: 'popup', associatedTabId: 42 })
 * await popout.activateTab()
 * await popout.close()
 * ```
 */
export interface PopoutHandle {
  /** popout ウィンドウの ID です。 */
  readonly windowId: number
  /** 元にした UI です。 */
  readonly source: PopoutSource
  /** 開いたページの絶対 URL です。 */
  readonly page: string
  /** 関連付けたタブの ID です。 */
  readonly associatedTabId?: number
  /** ページ設定を読んだタブ（`windowId` を指定した場合は解決後のタブ）です。 */
  readonly sourceTarget?: PopoutSourceTarget
  /** 再利用キーです。 */
  readonly reuseKey?: string
  /** ウィンドウの位置と大きさです。 */
  readonly bounds: PopoutBounds
  /** 作成時のオプション（ページなどは解決後の値）です。 */
  readonly options: Readonly<PopoutOptions>
  /** `closeOriginal` の結果です。`get()` などで取得したハンドルでは `not-requested` です。 */
  readonly originalUiClose: OriginalUiClose
  /** popout ウィンドウを閉じます。既に閉じている場合は何もしません。 */
  close(): Promise<void>
  /**
   * 関連付けたタブの最新情報を返します。
   *
   * @throws {WebextError} 関連タブがない場合は `CONTEXT_UNAVAILABLE`、閉じられた場合は `TAB_NOT_FOUND`
   */
  getTab(): Promise<PopoutTab>
  /** 関連付けたタブが存在するかを返します。関連タブがない場合は `false` です。 */
  tabExists(): Promise<boolean>
  /** 関連付けたタブをアクティブにし、そのウィンドウにフォーカスします。 */
  activateTab(): Promise<void>
  /**
   * 関連付けたタブの Content Script を `webextMessaging` の宛先として返します。
   *
   * @example
   * ```ts
   * await messaging.send('page:title', undefined, { target: popout.messageTarget() })
   * ```
   */
  messageTarget(options?: PopoutMessageTargetOptions): ContentScriptTarget
}
