// Only look up APIs when an operation runs. Preserve the native receiver and
// select each method independently so partial polyfills can coexist with chrome.
export function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null &&
    (typeof value === 'object' || typeof value === 'function')
    ? (value as Record<string, unknown>)
    : undefined
}

export function property(value: unknown, key: string): unknown {
  return object(value)?.[key]
}

export function nativeValue(...path: string[]): unknown {
  for (const name of ['browser', 'chrome']) {
    let value: unknown = property(globalThis, name)
    for (const key of path) value = property(value, key)
    if (value !== undefined) return value
  }
  return undefined
}

export function nativeMethod(
  ...path: string[]
): ((...args: unknown[]) => unknown) | undefined {
  for (const name of ['browser', 'chrome']) {
    let receiver: unknown = property(globalThis, name)
    for (const key of path.slice(0, -1)) receiver = property(receiver, key)
    const method = property(receiver, path[path.length - 1] ?? '')
    if (typeof method === 'function')
      return (...args) => method.apply(receiver, args)
  }
  return undefined
}

export function validId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
