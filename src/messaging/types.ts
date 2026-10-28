import type { ErrorCode, Unsubscribe } from '../internal/errors'

declare global {
  interface WebextMessages {}
}

export type MessageTarget =
  | {
      context: 'background'
      instanceId?: never
      tabId?: never
      windowId?: never
      frameId?: never
      documentId?: never
      world?: never
    }
  | {
      context: 'content-script'
      tabId: number
      world?: 'ISOLATED' | 'MAIN'
      frameId?: number
      documentId?: string
      instanceId?: string
      windowId?: never
    }
  | {
      context:
        | 'popup'
        | 'side-panel'
        | 'popout'
        | 'options'
        | 'extension-page'
        | 'devtools'
      windowId?: number
      tabId?: number
      instanceId?: string
      documentId?: string
      frameId?: never
      world?: never
    }

export interface MessageSender {
  readonly context: 'background' | 'content-script' | 'extension-page'
  readonly id: string
  readonly trust: 'extension' | 'page'
  readonly tabId?: number
  readonly frameId?: number
  readonly windowId?: number
  readonly documentId?: string
  readonly url?: string
}

export interface SendOptions {
  target?: MessageTarget
  timeoutMs?: number
  ignoreMissing?: boolean
}
export type Delivery<T> = { delivered: true; value: T } | { delivered: false }
export interface NotificationReport {
  readonly results: readonly (
    | { instanceId: string; delivered: true }
    | {
        instanceId: string
        delivered: false
        error: { code: ErrorCode; message: string }
      }
  )[]
}

type Messages<O> = Omit<WebextMessages, keyof O> & O
type Names<M> = {
  [K in keyof M]: M[K] extends { data: unknown; response: unknown } ? K : never
}[keyof M] &
  string
type Data<M, K extends PropertyKey> = K extends keyof M
  ? M[K] extends { data: infer D }
    ? D
    : never
  : never
type Response<M, K extends PropertyKey> = K extends keyof M
  ? M[K] extends { response: infer R }
    ? R
    : never
  : never
type VoidNames<M> = {
  [K in Names<M>]: [Response<M, K>] extends [void] ? K : never
}[Names<M>]
type Args<D, O> = undefined extends D
  ? [data?: D, options?: O]
  : void extends D
    ? [data?: D, options?: O]
    : [data: D, options?: O]
type AllArgs<D> = [
  data: D,
  options: Omit<SendOptions, 'ignoreMissing' | 'target'> & {
    target: MessageTarget
  },
]
type Result<R, O> = 'ignoreMissing' extends keyof O
  ? O extends { ignoreMissing: true }
    ? Delivery<R>
    : O extends { ignoreMissing: false | undefined }
      ? R
      : O extends { ignoreMissing?: infer I }
        ? true extends I
          ? R | Delivery<R>
          : R
        : R
  : R

export interface MessagingClient<O = {}> {
  send<K extends Names<Messages<O>>, const S extends SendOptions = {}>(
    name: K,
    ...args: Args<Data<Messages<O>, K>, S>
  ): Promise<Result<Response<Messages<O>, K>, S>>
  notify<K extends VoidNames<Messages<O>>, const S extends SendOptions = {}>(
    name: K,
    ...args: Args<Data<Messages<O>, K>, S>
  ): Promise<Result<void, S>>
  notifyAll<K extends VoidNames<Messages<O>>>(
    name: K,
    ...args: AllArgs<Data<Messages<O>, K>>
  ): Promise<NotificationReport>
  on<K extends Names<Messages<O>>>(
    name: K,
    handler: (
      data: Data<Messages<O>, K>,
      sender: MessageSender
    ) => Response<Messages<O>, K> | Promise<Response<Messages<O>, K>>
  ): Unsubscribe
  installPageBridge(options: PageBridgeOptions<O>): PageBridge
  ready(): Promise<void>
  dispose(): void
}

/** Channels correlate public traffic; they are not secrets or authentication. */
export interface MessagingOptions {
  bridge?: { channel: string; limits?: PageBridgeLimits }
}
export interface PageBridge {
  dispose(): void
}
export interface PageBridgeLimits {
  maxBytes?: number
  maxDepth?: number
  maxPending?: number
  requestsPerMinute?: number
}
type Policy<M> = {
  [K in Names<M>]?: {
    validateData: (value: unknown) => value is Data<M, K>
    validateResponse: (value: unknown) => value is Response<M, K>
  }
}
export interface PageBridgeOptions<O = {}> {
  channel: string
  allowedOrigins: readonly string[]
  fromPage: {
    [K in Names<Messages<O>>]?: NonNullable<Policy<Messages<O>>[K]> & {
      target: MessageTarget
    }
  }
  toPage: Policy<Messages<O>>
  limits?: PageBridgeLimits
}
