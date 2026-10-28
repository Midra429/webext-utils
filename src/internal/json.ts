import { WebextError } from './errors'

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

// Bound both traversal and encoded size, before native JSON/structured clone can
// silently coerce values. Read descriptors so getters/toJSON are never executed.
export function assertJson(
  value: unknown,
  operation = 'messaging',
  allowUndefined = false
): void {
  if (value === undefined && allowUndefined) return
  const path = new Set<object>()
  let nodes = 0
  function visit(item: unknown, depth: number): void {
    if (++nodes > 100000 || depth > 64) fail()
    if (item === null || typeof item === 'string' || typeof item === 'boolean')
      return
    if (typeof item === 'number' && Number.isFinite(item)) return
    if (typeof item !== 'object' || item === null || path.has(item)) fail()
    const proto: unknown = Object.getPrototypeOf(item)
    if (!Array.isArray(item) && proto !== Object.prototype && proto !== null)
      fail()
    path.add(item)
    const keys = Reflect.ownKeys(item)
    for (const key of keys) {
      if (Array.isArray(item) && key === 'length') continue
      if (typeof key !== 'string') fail()
      if (
        Array.isArray(item) &&
        (!Number.isSafeInteger(Number(key)) ||
          Number(key) < 0 ||
          String(Number(key)) !== key ||
          Number(key) >= item.length)
      )
        fail()
      const descriptor = Object.getOwnPropertyDescriptor(item, key)
      if (!descriptor?.enumerable || !('value' in descriptor)) fail()
      visit(descriptor.value, depth + 1)
    }
    if (Array.isArray(item) && keys.length !== item.length + 1) fail()
    path.delete(item)
  }
  function fail(): never {
    throw new WebextError(
      'SERIALIZATION_ERROR',
      operation,
      'Expected bounded JSON-compatible data'
    )
  }
  try {
    visit(value, 0)
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 1048576)
      fail()
  } catch (error) {
    if (error instanceof WebextError) throw error
    throw new WebextError(
      'SERIALIZATION_ERROR',
      operation,
      'JSON validation failed',
      { cause: error }
    )
  }
}
