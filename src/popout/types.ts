import type { WebextError } from '../internal/errors'
import type { MessageTarget } from '../messaging/types'
import type { SidePanelScope } from '../sidePanel/types'

export interface PopoutOptions {
  source: 'popup' | 'sidePanel'
  page?: string
  sourceTarget?: SidePanelScope
  associatedTabId?: number
  width?: number
  height?: number
  left?: number
  top?: number
  focused?: boolean
  reuseKey?: string
  closeOriginal?: boolean
}

export interface PopoutBounds {
  readonly width?: number
  readonly height?: number
  readonly left?: number
  readonly top?: number
}

/** Sensitive fields remain optional without tabs/host permissions. */
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

export type OriginalUiClose =
  | { readonly status: 'not-requested' | 'closed' | 'unsupported' }
  | { readonly status: 'failed'; readonly error: WebextError }

export interface PopoutHandle {
  readonly windowId: number
  readonly source: 'popup' | 'sidePanel'
  readonly page: string
  readonly associatedTabId?: number
  readonly sourceTarget?: SidePanelScope
  readonly reuseKey?: string
  readonly bounds: PopoutBounds
  readonly options: Readonly<PopoutOptions>
  readonly originalUiClose: OriginalUiClose
  close(): Promise<void>
  getTab(): Promise<PopoutTab>
  tabExists(): Promise<boolean>
  activateTab(): Promise<void>
  messageTarget(options?: {
    frameId?: number
    documentId?: string
    world?: 'ISOLATED' | 'MAIN'
  }): Extract<MessageTarget, { context: 'content-script' }>
}
