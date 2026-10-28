import type { ErrorCode, Unsubscribe } from '../internal/errors'
import type {
  SidePanelCapabilities,
  SidePanelEvent,
  SidePanelScope,
  SidePanelState,
  SidePanelTarget,
} from './types'

import { WebextError, isWebextError } from '../internal/errors'
import { isExtensionUrl, parseUrl } from '../internal/extension-url'
import { nativeMethod, object, property, validId } from '../internal/native'

export type { ErrorCode, Unsubscribe } from '../internal/errors'
export type {
  SidePanelCapabilities,
  SidePanelEvent,
  SidePanelScope,
  SidePanelState,
  SidePanelTarget,
} from './types'

export { WebextError, isWebextError } from '../internal/errors'

const CHROME_MAJOR = /\b(?:Chrome|Chromium|HeadlessChrome)\/(\d+)\b/
const GESTURE =
  /(?:user gesture|user action|user activation|user input handler)/i
const PERMISSION =
  /(?:permission denied|missing.*permission|requires? .*permission)/i
const TAB = /(?:no tab with id|invalid tab id)/i
const WINDOW = /(?:no window with id|invalid window id)/i

function fail(code: ErrorCode, operation: string, message: string): never {
  throw new WebextError(code, `sidePanel.${operation}`, message)
}

function convert(operation: string, cause: unknown): WebextError {
  if (isWebextError(cause)) return cause
  const message = cause instanceof Error ? cause.message : String(cause)
  const code = GESTURE.test(message)
    ? 'USER_GESTURE_REQUIRED'
    : PERMISSION.test(message)
      ? 'PERMISSION_DENIED'
      : TAB.test(message)
        ? 'TAB_NOT_FOUND'
        : WINDOW.test(message)
          ? 'WINDOW_NOT_FOUND'
          : 'NATIVE_ERROR'
  return new WebextError(code, `sidePanel.${operation}`, message, { cause })
}

function root(operation: string): URL {
  const url = parseUrl(nativeMethod('runtime', 'getURL')?.(''))
  if (!url || !isExtensionUrl(url, url))
    fail('CONTEXT_UNAVAILABLE', operation, 'Extension runtime is unavailable')
  return url
}

function scope(value: unknown, operation: string): SidePanelScope | undefined {
  if (value === undefined) return undefined
  const item = object(value)
  if (item && Object.keys(item).length === 1) {
    if (Object.keys(item)[0] === 'tabId' && validId(item.tabId))
      return { tabId: item.tabId }
    if (Object.keys(item)[0] === 'windowId' && validId(item.windowId))
      return { windowId: item.windowId }
  }
  return fail(
    'INVALID_ARGUMENT',
    operation,
    'Specify exactly one nonnegative tabId or windowId'
  )
}

function pageUrl(value: unknown, operation: string, fromNative = false): URL {
  const base = root(operation)
  let url: URL | undefined
  if (typeof value === 'string' && value.trim()) {
    try {
      url = new URL(value, base)
    } catch {
      /* Invalid URL below. */
    }
  }
  if (!url || !isExtensionUrl(url, base))
    fail(
      fromNative ? 'UNSUPPORTED_OPERATION' : 'INVALID_ARGUMENT',
      operation,
      'Panel page must belong to this extension'
    )
  return url
}

function supportsTabClose(): boolean {
  // This is the one version-dependent semantic difference (Chrome 145).
  // Unknown/reduced versions fail closed rather than closing another panel.
  const agent = property(property(globalThis, 'navigator'), 'userAgent')
  const match = typeof agent === 'string' ? CHROME_MAJOR.exec(agent) : null
  return !!match && Number(match[1]) >= 145
}

function method(operation: string, chrome: string, firefox: string) {
  root(operation)
  const panel = nativeMethod('sidePanel', chrome)
  if (panel) return { call: panel, chrome: true }
  const sidebar = nativeMethod('sidebarAction', firefox)
  if (sidebar) return { call: sidebar, chrome: false }
  return fail(
    'UNSUPPORTED_OPERATION',
    operation,
    'Native side panel operation is unavailable in this context'
  )
}

async function change(
  operation: 'open' | 'close',
  target?: SidePanelTarget
): Promise<void> {
  try {
    const selected = scope(target, operation)
    const native = method(operation, operation, operation)
    if (!native.chrome) {
      if (selected)
        fail(
          'UNSUPPORTED_OPERATION',
          operation,
          'Firefox supports active-window open/close only'
        )
      // Start synchronously in the user-action handler: no preflight await.
      await native.call()
      return
    }
    if (
      operation === 'close' &&
      selected &&
      'tabId' in selected &&
      !supportsTabClose()
    )
      fail(
        'UNSUPPORTED_OPERATION',
        operation,
        'Tab-only close requires a known Chrome version >=145; use windowId for global close'
      )
    if (selected) {
      await native.call(selected)
      return
    }
    const lastFocused = nativeMethod('windows', 'getLastFocused')
    if (!lastFocused)
      fail(
        'CONTEXT_UNAVAILABLE',
        operation,
        'Active window cannot be resolved; specify windowId'
      )
    const window = object(await lastFocused())
    if (!validId(window?.id))
      fail(
        'CONTEXT_UNAVAILABLE',
        operation,
        'No active browser window; specify windowId'
      )
    await native.call({ windowId: window.id })
  } catch (cause) {
    throw convert(operation, cause)
  }
}

async function setPage(path: string, target?: SidePanelScope): Promise<void> {
  const operation = 'setPage'
  try {
    const selected = scope(target, operation)
    const native = method(operation, 'setOptions', 'setPanel')
    if (native.chrome && selected && 'windowId' in selected)
      fail(
        'UNSUPPORTED_OPERATION',
        operation,
        'Chrome does not support window-scoped panel configuration'
      )
    const url = pageUrl(path, operation)
    await native.call(
      native.chrome
        ? {
            ...selected,
            path: `${url.pathname.slice(1)}${url.search}${url.hash}`,
          }
        : { ...selected, panel: url.href }
    )
  } catch (cause) {
    throw convert(operation, cause)
  }
}

async function getPage(target?: SidePanelScope): Promise<string | undefined> {
  const operation = 'getPage'
  try {
    const selected = scope(target, operation)
    const native = method(operation, 'getOptions', 'getPanel')
    if (native.chrome && selected && 'windowId' in selected)
      fail(
        'UNSUPPORTED_OPERATION',
        operation,
        'Chrome does not support window-scoped panel configuration'
      )
    const result = await native.call(selected ?? {})
    if (native.chrome && !object(result))
      fail('NATIVE_ERROR', operation, 'Invalid native panel options')
    const path = native.chrome ? property(result, 'path') : result
    if (path === undefined || path === '') return undefined
    return pageUrl(path, operation, true).href
  } catch (cause) {
    throw convert(operation, cause)
  }
}

async function getState(target: { windowId: number }): Promise<SidePanelState> {
  const operation = 'getState'
  try {
    const selected = scope(target, operation)
    if (!selected || !('windowId' in selected))
      fail('INVALID_ARGUMENT', operation, 'Specify windowId')
    root(operation)
    const isOpen = nativeMethod('sidebarAction', 'isOpen')
    if (isOpen) {
      const result = await isOpen(selected)
      if (typeof result !== 'boolean')
        fail('NATIVE_ERROR', operation, 'Invalid native sidebar state')
      return { state: result ? 'open' : 'closed', source: 'native' }
    }
    if (!nativeMethod('sidePanel', 'getOptions'))
      fail(
        'UNSUPPORTED_OPERATION',
        operation,
        'Native panel API is unavailable'
      )
    // Configuration, live documents and event history do not prove visibility.
    return { state: 'unknown', reason: 'NATIVE_STATE_UNAVAILABLE' }
  } catch (cause) {
    throw convert(operation, cause)
  }
}

function eventMethods(name: 'onOpened' | 'onClosed') {
  const add = nativeMethod('sidePanel', name, 'addListener')
  const remove = nativeMethod('sidePanel', name, 'removeListener')
  return add && remove ? { add, remove } : undefined
}

function subscribe(
  name: 'onOpened' | 'onClosed',
  handler: (event: SidePanelEvent) => void
): Unsubscribe {
  try {
    root(name)
    if (typeof handler !== 'function')
      fail('INVALID_ARGUMENT', name, 'Expected an event handler')
    const methods = eventMethods(name)
    if (!methods)
      fail('UNSUPPORTED_OPERATION', name, 'Native panel event is unavailable')
    let active = true
    const listener = (value: unknown) => {
      if (!active) return
      const info = object(value)
      if (
        !info ||
        !validId(info.windowId) ||
        (info.tabId !== undefined && !validId(info.tabId))
      )
        return
      let page: string
      try {
        page = pageUrl(info.path, name, true).href
      } catch {
        return
      }
      handler({
        windowId: info.windowId,
        ...(validId(info.tabId) ? { tabId: info.tabId } : {}),
        page,
        source: 'native',
      })
    }
    methods.add(listener)
    return () => {
      if (!active) return
      active = false
      try {
        methods.remove(listener)
      } catch (cause) {
        throw convert(name, cause)
      }
    }
  } catch (cause) {
    throw convert(name, cause)
  }
}

function getCapabilities(): SidePanelCapabilities {
  const available = (name: string, method: string) =>
    !!nativeMethod(name, method)
  const controls = (operation: 'open' | 'close') => {
    const panel = available('sidePanel', operation)
    return {
      activeWindow: panel
        ? available('windows', 'getLastFocused')
        : available('sidebarAction', operation),
      window: panel,
      tab: panel && (operation === 'open' || supportsTabClose()),
    }
  }
  const configuration = (chrome: string, firefox: string) => {
    const panel = available('sidePanel', chrome)
    const sidebar = available('sidebarAction', firefox)
    return {
      global: panel || sidebar,
      window: !panel && sidebar,
      tab: panel || sidebar,
    }
  }
  return {
    open: controls('open'),
    close: controls('close'),
    setPage: configuration('setOptions', 'setPanel'),
    getPage: configuration('getOptions', 'getPanel'),
    nativeState: available('sidebarAction', 'isOpen'),
    events: {
      opened: !!eventMethods('onOpened'),
      closed: !!eventMethods('onClosed'),
    },
  }
}

export const webextSidePanel = {
  open: (target?: SidePanelTarget): Promise<void> => change('open', target),
  close: (target?: SidePanelTarget): Promise<void> => change('close', target),
  setPage,
  getPage,
  getState,
  getCapabilities,
  onOpened: (handler: (event: SidePanelEvent) => void): Unsubscribe =>
    subscribe('onOpened', handler),
  onClosed: (handler: (event: SidePanelEvent) => void): Unsubscribe =>
    subscribe('onClosed', handler),
}
