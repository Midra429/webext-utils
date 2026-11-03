import { object } from '../../internal/browser'
import { assertJson } from '../../internal/json'
import { fail } from '../protocol'

export const PAGE_PROTOCOL = '@midra/webext-utils/page'
export function channel(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.length > 128)
    throw fail('INVALID_ARGUMENT', 'Invalid page channel')
}
export function eventName(channel: string, incoming: boolean): string {
  return `${PAGE_PROTOCOL}/1/${channel}/${incoming ? 'from-page' : 'to-page'}`
}
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

/**
 * Rejects prototype-related keys anywhere in a parsed value. The traversal is
 * iterative, so any nesting depth is handled without a stack overflow.
 */
function rejectUnsafeKeys(value: unknown): void {
  const stack: unknown[] = [value]
  while (stack.length) {
    const item = stack.pop()
    if (!item || typeof item !== 'object') continue
    for (const key of Object.keys(item)) {
      if (UNSAFE_KEYS.has(key))
        throw fail('VALIDATION_ERROR', 'Unsafe page object key')
      stack.push((item as Record<string, unknown>)[key])
    }
  }
}

/**
 * Serializes an outgoing page message. It uses the same JSON contract as all
 * extension messaging, so nothing larger can be relayed to the Background.
 */
export function encode(value: unknown): string {
  assertJson(value)
  rejectUnsafeKeys(value)
  return JSON.stringify(value)
}

/**
 * Parses an incoming page message. Its cost stays in the page's own process;
 * anything forwarded to the Background is checked again by messaging.
 */
export function decode(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string')
    throw fail('VALIDATION_ERROR', 'Invalid page event detail')
  const value: unknown = JSON.parse(raw)
  rejectUnsafeKeys(value)
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
