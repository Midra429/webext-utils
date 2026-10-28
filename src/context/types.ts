export type ContextSource =
  | 'native'
  | 'registered'
  | 'verified-record'
  | 'unknown'

export interface ContextMetadata {
  readonly source: ContextSource
  readonly tabId?: number
  readonly frameId?: number
  readonly windowId?: number
  readonly documentId?: string
  readonly instanceId?: string
}

type ViewKind =
  | 'popup'
  | 'side-panel'
  | 'options'
  | 'extension-page'
  | 'devtools'
type ViewContext = { [K in ViewKind]: { readonly kind: K } }[ViewKind]

export type ContextRegistration =
  | { readonly kind: 'background' }
  | { readonly kind: 'content-script'; readonly world: 'ISOLATED' | 'MAIN' }
  | ViewContext

export type ContextInfo = ContextMetadata &
  (
    | {
        readonly kind: 'background'
        readonly implementation: 'service-worker' | 'page'
      }
    | { readonly kind: 'content-script'; readonly world: 'ISOLATED' | 'MAIN' }
    | ViewContext
    | { readonly kind: 'unknown' }
    | {
        readonly kind: 'popout'
        readonly origin: 'popup' | 'sidePanel'
        readonly windowId: number
        readonly associatedTabId?: number
      }
  )
