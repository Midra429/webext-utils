export function parseUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string') return undefined
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}

// Extension schemes have opaque URL.origin ("null") in some runtimes.
// Compare the parsed scheme and authority, never opaque origins or URL prefixes.
export function isExtensionUrl(url: URL, root: URL): boolean {
  return (
    (root.protocol === 'chrome-extension:' ||
      root.protocol === 'moz-extension:') &&
    url.protocol === root.protocol &&
    url.host === root.host &&
    !url.username &&
    !url.password
  )
}
