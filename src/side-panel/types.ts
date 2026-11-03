import type { WebextError } from '../internal/errors'

/**
 * 開閉や状態確認の対象ウィンドウを指定するオプションです。
 *
 * 省略すると、最後にフォーカスされたブラウザウィンドウ（= ユーザーが操作中のウィンドウ）を対象にします。
 */
export interface SidePanelWindowOptions {
  /**
   * 対象のウィンドウ ID です。
   *
   * `open` / `close` / `toggle` で指定する場合は、ユーザーが操作したウィンドウ
   * （例: `action.onClicked` の `tab.windowId`）を渡してください。
   * Firefox はユーザー操作中のウィンドウでしか開閉できないため、ライブラリは両ブラウザで
   * この前提のもとに同じ動作をします。
   */
  windowId?: number
}

/**
 * ページ設定の対象です。省略すると全ウィンドウ共通の設定です。
 *
 * - `{ windowId }`: そのウィンドウのパネル
 * - `{ tabId }`: そのタブがアクティブなときのパネル
 *
 * 優先順位は「タブ > ウィンドウ > 全体」です。開閉状態はウィンドウ単位のままで、
 * パネルの内容がアクティブなタブ・ウィンドウに応じて切り替わります。
 */
export type SidePanelPageTarget =
  | { windowId: number; tabId?: never }
  | { tabId: number; windowId?: never }

/** サイドパネルが開いた・閉じたときに通知される情報です。 */
export interface SidePanelEvent {
  /** パネルが開いた（閉じた）ウィンドウの ID です。 */
  readonly windowId: number
  /** パネルに表示されていたページの絶対 URL です（例: `chrome-extension://<id>/panel.html`）。 */
  readonly page: string
}

/** {@link SidePanelEvent} を受け取るリスナーです。 */
export type SidePanelListener = (event: SidePanelEvent) => void

/** `webextSidePanel.startBackground()` のオプションです。 */
export interface SidePanelBackgroundOptions {
  /**
   * `true` にすると、ツールバーの拡張機能アイコン（action）のクリックでサイドパネルを開閉します。
   *
   * Manifest の `action.default_popup` を設定している場合、クリックはポップアップを開くため動作しません。
   *
   * @default false
   */
  openOnActionClick?: boolean
  /**
   * アイコンのクリックによる開閉が失敗したときに呼ばれます。
   * 省略した場合、失敗は無視されます。
   */
  onError?(error: WebextError): void
}
