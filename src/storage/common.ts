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
export function key(value: unknown): asserts value is string {
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
