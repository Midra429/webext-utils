/** Configuration scope; omitted means the global default. */
export type SidePanelScope =
  | { tabId: number; windowId?: never }
  | { windowId: number; tabId?: never }

/** Omitted means the active window, not all windows. */
export type SidePanelTarget = SidePanelScope

export type SidePanelState =
  | { state: 'open' | 'closed'; source: 'native' }
  | { state: 'unknown'; reason: 'NATIVE_STATE_UNAVAILABLE' }

export interface SidePanelEvent {
  windowId: number
  tabId?: number
  /** Normalized URL within this extension. */
  page: string
  source: 'native'
}

export interface SidePanelCapabilities {
  /** Availability in this context, not a guarantee of permission or activation. */
  open: { activeWindow: boolean; window: boolean; tab: boolean }
  close: { activeWindow: boolean; window: boolean; tab: boolean }
  setPage: { global: boolean; window: boolean; tab: boolean }
  getPage: { global: boolean; window: boolean; tab: boolean }
  nativeState: boolean
  events: { opened: boolean; closed: boolean }
}
