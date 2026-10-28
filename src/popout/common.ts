import type { ErrorCode } from '../internal/errors'
import type { PopoutOptions } from './types'

import { WebextError, isWebextError } from '../internal/errors'
import { isExtensionUrl, parseUrl } from '../internal/extension-url'
import { nativeMethod, object, validId } from '../internal/native'
import { POPOUT_PARAM } from '../internal/popout-record'

const TAB = /no tab with id|invalid tab id/i
const WINDOW = /no window with id|invalid window id/i
const PERMISSION = /permission|access denied/i
const QUOTA = /quota/i

export function fail(code: ErrorCode, message: string): never {
  throw new WebextError(code, 'popout', message)
}
export function convert(cause: unknown): WebextError {
  if (isWebextError(cause)) return cause
  const message = cause instanceof Error ? cause.message : String(cause)
  const code = TAB.test(message)
    ? 'TAB_NOT_FOUND'
    : WINDOW.test(message)
      ? 'WINDOW_NOT_FOUND'
      : PERMISSION.test(message)
        ? 'PERMISSION_DENIED'
        : QUOTA.test(message)
          ? 'QUOTA_EXCEEDED'
          : 'NATIVE_ERROR'
  return new WebextError(code, 'popout', message, { cause })
}
export async function call(
  path: string[],
  ...args: unknown[]
): Promise<unknown> {
  const method = nativeMethod(...path)
  if (!method) fail('UNSUPPORTED_OPERATION', `Missing ${path.join('.')}`)
  try {
    return await method(...args)
  } catch (cause) {
    throw convert(cause)
  }
}
export function root(): URL {
  const base = parseUrl(nativeMethod('runtime', 'getURL')?.(''))
  if (!base || !isExtensionUrl(base, base))
    fail('CONTEXT_UNAVAILABLE', 'Extension runtime is unavailable')
  return base
}
export function page(value: unknown): string {
  const base = root()
  let url: URL | undefined
  if (typeof value === 'string' && value.trim()) {
    try {
      url = new URL(value, base)
    } catch {
      /* Rejected below. */
    }
  }
  if (!url || !isExtensionUrl(url, base) || url.searchParams.has(POPOUT_PARAM))
    fail(
      'INVALID_ARGUMENT',
      'Specify an extension page without reserved query parameters'
    )
  url.search = url.searchParams.toString()
  return url.href
}
export function id(value: unknown): asserts value is number {
  if (!validId(value))
    fail('INVALID_ARGUMENT', 'Expected a nonnegative integer ID')
}
export function options(value: unknown): PopoutOptions {
  const v = object(value)
  if (
    !v ||
    !['popup', 'sidePanel'].includes(String(v.source)) ||
    Object.keys(v).some(
      (k) =>
        ![
          'source',
          'page',
          'sourceTarget',
          'associatedTabId',
          'width',
          'height',
          'left',
          'top',
          'focused',
          'reuseKey',
          'closeOriginal',
        ].includes(k)
    )
  )
    fail('INVALID_ARGUMENT', 'Invalid popout options')
  for (const k of ['width', 'height', 'left', 'top'] as const) {
    const n = v[k]
    if (
      n !== undefined &&
      (typeof n !== 'number' ||
        !Number.isSafeInteger(n) ||
        ((k === 'width' || k === 'height') && n <= 0))
    )
      fail('INVALID_ARGUMENT', `Invalid ${k}`)
  }
  for (const k of ['focused', 'closeOriginal'])
    if (v[k] !== undefined && typeof v[k] !== 'boolean')
      fail('INVALID_ARGUMENT', `Invalid ${k}`)
  if (v.associatedTabId !== undefined) id(v.associatedTabId)
  if (
    v.reuseKey !== undefined &&
    (typeof v.reuseKey !== 'string' ||
      !v.reuseKey.trim() ||
      v.reuseKey.length > 256)
  )
    fail('INVALID_ARGUMENT', 'Invalid reuseKey')
  const target = object(v.sourceTarget)
  if (v.sourceTarget !== undefined) {
    if (
      !target ||
      Object.keys(target).length !== 1 ||
      !['tabId', 'windowId'].includes(Object.keys(target)[0] ?? '')
    )
      fail('INVALID_ARGUMENT', 'Specify one sourceTarget ID')
    id(target.tabId ?? target.windowId)
  }
  return {
    ...v,
    ...(v.page === undefined ? {} : { page: page(v.page) }),
    ...(target ? { sourceTarget: { ...target } } : {}),
  } as unknown as PopoutOptions
}
