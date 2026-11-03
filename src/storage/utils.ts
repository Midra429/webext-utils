import { WebextError } from '../internal/errors'
import { assertJson } from '../internal/json'

export const META = '__webext_utils__storage_v1_meta'
export const JOURNAL = '__webext_utils__storage_v1_journal'
export const SYNC_JOURNAL = '__webext_utils__storage_v1_sync_journal'
export function fail(
  code: ConstructorParameters<typeof WebextError>[0],
  message: string,
  cause?: unknown
): WebextError {
  return new WebextError(
    code,
    'storage',
    message,
    cause === undefined ? undefined : { cause }
  )
}
/**
 * Top-level keys that some native storage implementations confuse with
 * `Object.prototype` members (Firefox `storage.session` drops `toString`).
 * They are rejected in every browser so behavior stays identical.
 */
const PROTOTYPE_KEYS: ReadonlySet<string> = new Set(
  Object.getOwnPropertyNames(Object.prototype)
)

/** Validates a full storage key (segments plus top-level restrictions). */
export function key(value: unknown): asserts value is string {
  segments(value)
  if (!value.includes('.') && PROTOTYPE_KEYS.has(value))
    throw fail(
      'INVALID_ARGUMENT',
      `"${value}" cannot be used as a top-level storage key; use a namespace such as "app.${value}"`
    )
}

/** Joins a namespace prefix and a relative key, validating the result. */
export function join(prefix: string, relative: unknown): string {
  segments(relative)
  const full = prefix ? `${prefix}.${relative}` : relative
  key(full)
  return full
}

/** Validates dot-separated segments (used for prefixes and relative keys). */
export function segments(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value ||
    value
      .split('.')
      .some(
        (p) =>
          !p ||
          p.startsWith('__webext_utils') ||
          ['__proto__', 'constructor', 'prototype'].includes(p)
      )
  )
    throw fail('INVALID_ARGUMENT', 'Invalid or reserved storage key')
}
export function within(full: string, prefix: string): boolean {
  return !prefix || full.startsWith(`${prefix}.`)
}
export function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (
    !a ||
    !b ||
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    Array.isArray(a) !== Array.isArray(b)
  )
    return false
  const x = Object.keys(a),
    y = Object.keys(b)
  return (
    x.length === y.length &&
    x.every(
      (k) =>
        Object.hasOwn(b, k) &&
        equal(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k]
        )
    )
  )
}
export function clone<T>(value: T): T {
  assertJson(value, 'storage')
  return JSON.parse(JSON.stringify(value)) as T
}
export function keys(value: unknown): string[] {
  if (!Array.isArray(value))
    throw fail('INVALID_ARGUMENT', 'Expected storage keys')
  value.forEach(key)
  return [...new Set(value)] as string[]
}
