/**
 * {@link ContextInfo} の判定根拠です。
 *
 * - `native`: ブラウザ API から確認した
 * - `registered`: `webextContext.register()` で宣言された
 * - `verified-record`: popout の記録とタブ・ウィンドウを照合して確認した
 * - `unknown`: 判定できなかった
 */
export type ContextSource =
  | 'native'
  | 'registered'
  | 'verified-record'
  | 'unknown'

/** すべての {@link ContextInfo} に共通する情報です。確認できた値だけを持ちます。 */
export interface ContextMetadata {
  /** 判定根拠です。 */
  readonly source: ContextSource
  /** このページが属するタブの ID です（ポップアップやサイドパネルにはありません）。 */
  readonly tabId?: number
  /** フレーム ID です（トップレベルは `0`）。 */
  readonly frameId?: number
  /** このページが属するウィンドウの ID です。 */
  readonly windowId?: number
  /** ブラウザが割り当てた文書 ID です。 */
  readonly documentId?: string
  /** 実行コンテキストの ID です（popout では popout の識別子）。 */
  readonly instanceId?: string
}

/** 拡張機能のページ（Background 以外の拡張機能 UI）の種類です。 */
export type ViewKind =
  | 'popup'
  | 'side-panel'
  | 'options'
  | 'extension-page'
  | 'devtools'

type ViewContext = { [K in ViewKind]: { readonly kind: K } }[ViewKind]

/**
 * Content Script の実行ワールドです。
 *
 * - `ISOLATED`: 拡張機能 API を使える通常の Content Script
 * - `MAIN`: ページと同じ JavaScript 環境（拡張機能 API は使えない）
 */
export type ContentScriptWorld = 'ISOLATED' | 'MAIN'

/**
 * `webextContext.register()` で宣言できる実行場所です。
 *
 * @example
 * ```ts
 * webextContext.register({ kind: 'options' })
 * webextContext.register({ kind: 'content-script', world: 'MAIN' })
 * ```
 */
export type ContextRegistration =
  | { readonly kind: 'background' }
  | { readonly kind: 'content-script'; readonly world: ContentScriptWorld }
  | ViewContext

/**
 * 現在のコードが実行されている場所です。`kind` で絞り込めます。
 *
 * | `kind` | 実行場所 | 追加の項目 |
 * | --- | --- | --- |
 * | `background` | Background（Service Worker / イベントページ） | |
 * | `content-script` | Content Script | `world` |
 * | `popup` | ツールバーアイコンのポップアップ | |
 * | `side-panel` | サイドパネル | |
 * | `popout` | `webextPopout` で開いた独立ウィンドウ | `origin`, `windowId`, `associatedTabId?` |
 * | `options` | オプションページ（`register` で宣言） | |
 * | `extension-page` | タブで開いた拡張機能のページ | |
 * | `devtools` | 開発者ツールのページ | |
 * | `unknown` | 判定できない | |
 *
 * @example
 * ```ts
 * const context = await webextContext.resolve()
 * if (context.kind === 'content-script') console.log(context.world)
 * ```
 */
export type ContextInfo = ContextMetadata &
  (
    | { readonly kind: 'background' }
    | { readonly kind: 'content-script'; readonly world: ContentScriptWorld }
    | ViewContext
    | { readonly kind: 'unknown' }
    | {
        readonly kind: 'popout'
        /** popout の元になった UI です。 */
        readonly origin: 'popup' | 'side-panel'
        readonly windowId: number
        /** popout に関連付けたタブの ID です。 */
        readonly associatedTabId?: number
      }
  )

/** {@link ContextInfo} の `kind` です。 */
export type ContextKind = ContextInfo['kind']
