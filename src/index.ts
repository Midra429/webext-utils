/**
 * Chrome・Firefox の Manifest V3 拡張機能向けユーティリティです。
 *
 * 各機能はサブパスからも import できます（`@midra/webext-utils/messaging` など）。
 *
 * @module
 */

export type {
  ContentScriptWorld,
  ContextInfo,
  ContextKind,
  ContextMetadata,
  ContextRegistration,
  ContextSource,
  ViewKind,
} from './context'
export type { ErrorCode, WebextErrorOptions } from './internal/errors'
export type { JsonValue } from './internal/json'
export type { Subscription, Unsubscribe } from './internal/types'
export type {
  BackgroundTarget,
  ContentScriptTarget,
  Delivery,
  MessageData,
  MessageHandler,
  MessageMap,
  MessageName,
  MessageResponse,
  MessageSender,
  MessageTarget,
  MessagingClient,
  MessagingOptions,
  NotificationName,
  NotificationReport,
  PageBridge,
  PageBridgeLimits,
  PageBridgeOptions,
  PageMessageRule,
  ResolvedMessages,
  SendOptions,
  ViewTarget,
  ViewTargetContext,
} from './messaging'
export type {
  OriginalUiClose,
  PopoutBaseOptions,
  PopoutBounds,
  PopoutHandle,
  PopoutMessageTargetOptions,
  PopoutOptions,
  PopoutSource,
  PopoutSourceTarget,
  PopoutTab,
  PopupPopoutOptions,
  SidePanelPopoutOptions,
} from './popout'
export type {
  SidePanelBackgroundOptions,
  SidePanelEvent,
  SidePanelListener,
  SidePanelWindowOptions,
} from './side-panel'
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
} from './storage'

export { webextContext } from './context'
export { WebextError, isWebextError } from './internal/errors'
export { webextMessaging } from './messaging'
export { webextPopout } from './popout'
export { webextSidePanel } from './side-panel'
export { webextStorage } from './storage'
