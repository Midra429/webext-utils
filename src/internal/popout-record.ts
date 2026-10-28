import { nativeMethod, object, validId } from './native'

// Shared wire format for the popout writer and context reader. Not a public API.
export const POPOUT_PARAM = '__webext_utils_popout'
export const POPOUT_KEY_PREFIX = '__webext_utils:popout:'
const TOKEN_PATTERN = /^[\w-]{16,128}$/

export interface PopoutRecord {
  version: 1
  status: 'ready'
  token: string
  windowId: number
  tabId: number
  source: 'popup' | 'sidePanel'
  page: string
  associatedTabId?: number
}

export function popoutToken(url: URL): string | undefined {
  const tokens = url.searchParams.getAll(POPOUT_PARAM)
  return tokens.length === 1 && TOKEN_PATTERN.test(tokens[0] ?? '')
    ? tokens[0]
    : undefined
}

export function popoutPage(url: URL): string {
  const page = new URL(url.href)
  page.searchParams.delete(POPOUT_PARAM)
  return page.href
}

export async function readPopoutRecord(
  url: URL,
  tabId: number,
  windowId: number
): Promise<PopoutRecord | undefined> {
  const token = popoutToken(url)
  const get = nativeMethod('storage', 'session', 'get')
  if (!token || !get) return undefined
  const key = `${POPOUT_KEY_PREFIX}${token}`
  // Pending records can become ready while the newly created page starts.
  for (let attempt = 0; attempt < 4; attempt++) {
    const value = object(object(await get(key))?.[key])
    if (
      !value ||
      value.version !== 1 ||
      value.token !== token ||
      value.page !== popoutPage(url)
    )
      return undefined
    if (value.status === 'pending' && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 25))
      continue
    }
    if (
      value.status !== 'ready' ||
      value.tabId !== tabId ||
      value.windowId !== windowId ||
      !validId(value.tabId) ||
      !validId(value.windowId) ||
      (value.source !== 'popup' && value.source !== 'sidePanel') ||
      (value.associatedTabId !== undefined && !validId(value.associatedTabId))
    )
      return undefined
    return {
      version: 1,
      status: 'ready',
      token,
      tabId,
      windowId,
      source: value.source,
      page: value.page as string,
      ...(validId(value.associatedTabId)
        ? { associatedTabId: value.associatedTabId }
        : {}),
    }
  }
  return undefined
}
