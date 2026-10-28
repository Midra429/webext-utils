export type {
  ContextInfo,
  ContextMetadata,
  ContextRegistration,
  ContextSource,
  ErrorCode,
  Unsubscribe,
} from './context'
export type {
  Delivery,
  JsonValue,
  MessageSender,
  MessageTarget,
  MessagingClient,
  MessagingOptions,
  NotificationReport,
  PageBridge,
  PageBridgeLimits,
  PageBridgeOptions,
  SendOptions,
} from './messaging'
export type {
  OriginalUiClose,
  PopoutBounds,
  PopoutHandle,
  PopoutOptions,
  PopoutTab,
} from './popout'
export type {
  SidePanelCapabilities,
  SidePanelEvent,
  SidePanelScope,
  SidePanelState,
  SidePanelTarget,
} from './sidePanel'
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
} from './storage'

export { WebextError, isWebextError, webextContext } from './context'
export { webextMessaging } from './messaging'
export { webextPopout } from './popout'
export { webextSidePanel } from './sidePanel'
export { webextStorage } from './storage'
