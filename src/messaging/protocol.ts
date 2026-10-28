import type { ErrorCode } from '../internal/errors'
import type { MessageSender, MessageTarget } from './types'

import { WebextError, nativeError } from '../internal/errors'
import { assertJson } from '../internal/json'
import { object, validId } from '../internal/native'

export const PROTOCOL = '@midra/webext-utils/messaging'
export const PORT = `${PROTOCOL}/1`
export const RECORD_PREFIX = '__webext_utils_messaging_v1__:'
export const DEFAULT_TIMEOUT = 10000
export interface Request {
  protocol: typeof PROTOCOL
  version: 1
  type: 'request'
  id: string
  deadline: number
  name: string
  target: MessageTarget
  mode: 'send' | 'notify' | 'all'
  page?: boolean
  data?: unknown
}
export interface Endpoint {
  instanceId: string
  generation: number
  context: MessageTarget['context']
  names: string[]
  tabId?: number
  frameId?: number
  windowId?: number
  documentId?: string
  world?: 'ISOLATED' | 'MAIN'
}
export type Reply = {
  protocol: typeof PROTOCOL
  version: 1
  type: 'reply'
  id: string
} & (
  | { ok: true; value?: unknown }
  | { ok: false; error: { code: ErrorCode; message: string } }
)
export function fail(code: ErrorCode, message: string): WebextError {
  return new WebextError(code, 'messaging', message)
}
export function wire(type: string, extra: Record<string, unknown> = {}) {
  return { protocol: PROTOCOL, version: 1, type, ...extra }
}
export function envelope(value: unknown): Record<string, unknown> | undefined {
  const v = object(value)
  if (v?.protocol !== PROTOCOL) return
  assertJson(value)
  if (v.version !== 1 || typeof v.type !== 'string')
    throw fail('VALIDATION_ERROR', 'Unsupported messaging protocol')
  return v
}
export function name(
  value: unknown,
  internal = false
): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > 256 ||
    (value.startsWith('__webext_utils') && !internal)
  )
    throw fail('INVALID_ARGUMENT', 'Invalid message name')
}
const views = new Set([
  'popup',
  'side-panel',
  'popout',
  'options',
  'extension-page',
  'devtools',
])
export function target(value: unknown): MessageTarget {
  const v = object(value)
  if (!v) throw fail('INVALID_ARGUMENT', 'Missing target')
  const allowed = new Set(['context'])
  if (v.context === 'content-script') {
    for (const k of ['tabId', 'frameId', 'world', 'documentId', 'instanceId'])
      allowed.add(k)
    if (
      !validId(v.tabId) ||
      (v.world !== undefined && v.world !== 'ISOLATED' && v.world !== 'MAIN')
    )
      throw fail('INVALID_ARGUMENT', 'Invalid content-script target')
  } else if (typeof v.context === 'string' && views.has(v.context)) {
    for (const k of ['tabId', 'windowId', 'documentId', 'instanceId'])
      allowed.add(k)
  } else if (v.context !== 'background')
    throw fail('INVALID_ARGUMENT', 'Unknown target context')
  for (const [key, val] of Object.entries(v)) {
    if (!allowed.has(key))
      throw fail('INVALID_ARGUMENT', `Incompatible target field: ${key}`)
    if (['tabId', 'frameId', 'windowId'].includes(key) && !validId(val))
      throw fail('INVALID_ARGUMENT', `Invalid ${key}`)
    if (
      ['documentId', 'instanceId'].includes(key) &&
      (typeof val !== 'string' || !val.length)
    )
      throw fail('INVALID_ARGUMENT', `Invalid ${key}`)
  }
  return v as MessageTarget
}
export function request(value: unknown): Request {
  const v = envelope(value)
  if (
    !v ||
    v.type !== 'request' ||
    typeof v.id !== 'string' ||
    !v.id.length ||
    v.id.length > 128 ||
    typeof v.deadline !== 'number' ||
    !Number.isFinite(v.deadline) ||
    v.deadline > Date.now() + 2147483647 ||
    (v.page !== undefined && typeof v.page !== 'boolean') ||
    !['send', 'notify', 'all'].includes(String(v.mode))
  )
    throw fail('VALIDATION_ERROR', 'Invalid request')
  name(v.name, true)
  target(v.target)
  return v as unknown as Request
}
export function success(id: string, value: unknown): Reply {
  assertJson(value, 'messaging.response', true)
  return {
    ...wire('reply'),
    id,
    ok: true,
    ...(value === undefined ? {} : { value }),
  } as Reply
}
export function failure(id: string, error: unknown): Reply {
  const e = nativeError('messaging', error)
  return {
    ...wire('reply'),
    id,
    ok: false,
    error: { code: e.code, message: e.message },
  } as Reply
}
const codes = new Set<ErrorCode>([
  'UNSUPPORTED_OPERATION',
  'PERMISSION_DENIED',
  'NO_RECEIVER',
  'AMBIGUOUS_TARGET',
  'TIMEOUT',
  'CONTEXT_UNAVAILABLE',
  'INVALID_ARGUMENT',
  'SERIALIZATION_ERROR',
  'VALIDATION_ERROR',
  'ACCESS_DENIED',
  'HANDLER_ERROR',
  'TRANSPORT_CLOSED',
  'ROUTER_UNAVAILABLE',
  'MIGRATION_FAILED',
  'SCHEMA_TOO_NEW',
  'MIGRATION_CONFLICT',
  'TAB_NOT_FOUND',
  'WINDOW_NOT_FOUND',
  'QUOTA_EXCEEDED',
  'USER_GESTURE_REQUIRED',
  'NATIVE_ERROR',
])
export function reply(value: unknown, id: string): unknown {
  const v = envelope(value)
  if (!v || v.type !== 'reply' || v.id !== id || typeof v.ok !== 'boolean')
    throw fail('VALIDATION_ERROR', 'Invalid response envelope')
  if (v.ok) return v.value
  const e = object(v.error)
  if (!e || !codes.has(e.code as ErrorCode) || typeof e.message !== 'string')
    throw fail('VALIDATION_ERROR', 'Invalid response error')
  throw fail(e.code as ErrorCode, e.message)
}
export function sender(value: unknown, extensionId: unknown): MessageSender {
  const v = object(value)
  if (!v || typeof v.id !== 'string' || v.id !== extensionId)
    throw fail('ACCESS_DENIED', 'Sender is not this extension')
  const tab = object(v.tab)
  return {
    id: String(v.id),
    trust: 'extension',
    context: validId(tab?.id) ? 'content-script' : 'extension-page',
    ...(validId(tab?.id) ? { tabId: tab.id } : {}),
    ...(validId(tab?.windowId) ? { windowId: tab.windowId } : {}),
    ...(validId(v.frameId) ? { frameId: v.frameId } : {}),
    ...(typeof v.documentId === 'string' ? { documentId: v.documentId } : {}),
    ...(typeof v.url === 'string' ? { url: v.url } : {}),
  }
}
export function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message ===
      'Could not establish connection. Receiving end does not exist.' ||
      error.message ===
        'Could not establish connection. Receiving end does not exist')
  )
}
export async function deadline<T>(
  promise: Promise<T>,
  until: number,
  ...cancellations: Set<(error: WebextError) => void>[]
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancel!: (error: WebextError) => void
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        cancel = reject
        for (const group of cancellations) group.add(cancel)
        timer = setTimeout(
          () => reject(fail('TIMEOUT', 'Messaging deadline exceeded')),
          Math.max(0, until - Date.now())
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
    for (const group of cancellations) group.delete(cancel)
  }
}
export function matches(e: Endpoint, t: MessageTarget, all: boolean): boolean {
  if (e.context !== t.context) return false
  for (const key of ['tabId', 'windowId', 'instanceId', 'documentId'] as const)
    if (
      key in t &&
      t[key as keyof MessageTarget] !== undefined &&
      t[key as keyof MessageTarget] !== e[key]
    )
      return false
  if (t.context === 'content-script') {
    if ((t.world ?? 'ISOLATED') !== e.world) return false
    if ((t.frameId !== undefined || !all) && (t.frameId ?? 0) !== e.frameId)
      return false
  }
  return true
}
