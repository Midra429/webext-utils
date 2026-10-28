export type ErrorCode =
  | 'UNSUPPORTED_OPERATION'
  | 'PERMISSION_DENIED'
  | 'NO_RECEIVER'
  | 'AMBIGUOUS_TARGET'
  | 'TIMEOUT'
  | 'CONTEXT_UNAVAILABLE'
  | 'INVALID_ARGUMENT'
  | 'SERIALIZATION_ERROR'
  | 'VALIDATION_ERROR'
  | 'ACCESS_DENIED'
  | 'HANDLER_ERROR'
  | 'TRANSPORT_CLOSED'
  | 'ROUTER_UNAVAILABLE'
  | 'MIGRATION_FAILED'
  | 'SCHEMA_TOO_NEW'
  | 'MIGRATION_CONFLICT'
  | 'TAB_NOT_FOUND'
  | 'WINDOW_NOT_FOUND'
  | 'QUOTA_EXCEEDED'
  | 'USER_GESTURE_REQUIRED'
  | 'NATIVE_ERROR'

export type Unsubscribe = () => void

export class WebextError extends Error {
  override readonly name = 'WebextError'

  constructor(
    readonly code: ErrorCode,
    readonly operation: string,
    message: string,
    options?: { cause?: unknown; details?: Readonly<Record<string, unknown>> }
  ) {
    super(message, options)
    this.details = options?.details
  }

  readonly details: Readonly<Record<string, unknown>> | undefined
}

export function isWebextError(error: unknown): error is WebextError {
  return error instanceof WebextError
}

export function nativeError(operation: string, cause: unknown): WebextError {
  return isWebextError(cause)
    ? cause
    : new WebextError(
        'NATIVE_ERROR',
        operation,
        `Native operation failed: ${operation}`,
        { cause }
      )
}
