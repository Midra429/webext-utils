import type { PageBridgeLimits } from './types'

import { assertJson } from '../internal/json'
import { object } from '../internal/native'
import { fail } from './protocol'

export const PAGE_PROTOCOL = '@midra/webext-utils/page'
export const defaults = {
  maxBytes: 65536,
  maxDepth: 32,
  maxPending: 32,
  requestsPerMinute: 60,
}
export type Limits = typeof defaults
export function limits(options: PageBridgeLimits = {}): Limits {
  const result = { ...defaults, ...options }
  for (const [key, value] of Object.entries(result))
    if (
      !Object.hasOwn(defaults, key) ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > 1048576
    )
      throw fail('INVALID_ARGUMENT', 'Invalid page bridge limits')
  // Keep recursive validation below the JavaScript stack limit.
  if (result.maxDepth > 64)
    throw fail('INVALID_ARGUMENT', 'maxDepth exceeds 64')
  return result
}
export function channel(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.length > 128)
    throw fail('INVALID_ARGUMENT', 'Invalid page channel')
}
export function eventName(channel: string, incoming: boolean): string {
  return `${PAGE_PROTOCOL}/1/${channel}/${incoming ? 'from-page' : 'to-page'}`
}
export function bounded(value: unknown, bound: Limits, depth = 0): void {
  if (depth > bound.maxDepth)
    throw fail('VALIDATION_ERROR', 'Page message too deep')
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key))
        throw fail('VALIDATION_ERROR', 'Unsafe page object key')
      bounded((value as Record<string, unknown>)[key], bound, depth + 1)
    }
  }
}
export function encode(value: unknown, bound: Limits): string {
  assertJson(value)
  bounded(value, bound)
  const raw = JSON.stringify(value)
  if (
    raw.length > bound.maxBytes ||
    new TextEncoder().encode(raw).length > bound.maxBytes
  )
    throw fail('VALIDATION_ERROR', 'Page message too large')
  return raw
}
export function decode(raw: unknown, bound: Limits): Record<string, unknown> {
  if (
    typeof raw !== 'string' ||
    raw.length > bound.maxBytes ||
    new TextEncoder().encode(raw).length > bound.maxBytes
  )
    throw fail('VALIDATION_ERROR', 'Invalid page event detail')
  const value: unknown = JSON.parse(raw)
  // JSON.parse has no getters; the byte bound caps the traversal work.
  bounded(value, bound)
  const v = object(value)
  if (
    !v ||
    v.protocol !== PAGE_PROTOCOL ||
    v.version !== 1 ||
    !['from-page', 'to-page'].includes(String(v.direction)) ||
    typeof v.id !== 'string' ||
    !v.id.length ||
    v.id.length > 128 ||
    typeof v.session !== 'string' ||
    !v.session.length ||
    v.session.length > 128
  )
    throw fail('VALIDATION_ERROR', 'Invalid page envelope')
  const fields: Record<string, string[]> = {
    hello: ['names'],
    ready: [],
    close: [],
    request: ['name', 'data', 'mode', 'target', 'timeoutMs', 'sender'],
    reply: ['ok', 'value', 'error'],
    service: ['name', 'data'],
    'service-event': ['name', 'data'],
  }
  const extra = typeof v.type === 'string' ? fields[v.type] : undefined
  if (!extra) throw fail('VALIDATION_ERROR', 'Invalid page command')
  const allowed = [
    'protocol',
    'version',
    'direction',
    'type',
    'id',
    'session',
    ...extra,
  ]
  if (Object.keys(v).some((key) => !allowed.includes(key)))
    throw fail('VALIDATION_ERROR', 'Unknown page field')
  return v
}

/** Only touches browser globals when a bridge is explicitly used. */
export class PageEnvironment {
  document = globalThis.document
  window = globalThis.window
  origin(): string {
    return globalThis.origin
  }
  href(): string {
    return globalThis.location.href
  }
  emit(type: string, detail: string): void {
    this.document.dispatchEvent(new CustomEvent(type, { detail }))
  }
}
