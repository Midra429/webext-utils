import type { ContextInfo } from '../context'
import type { Unsubscribe } from '../internal/errors'
import type { Ready } from './manager'
import type {
  OriginalUiClose,
  PopoutHandle,
  PopoutOptions,
  PopoutTab,
} from './types'

import { webextContext } from '../context'
import { isExtensionUrl, parseUrl } from '../internal/extension-url'
import { nativeMethod, object, validId } from '../internal/native'
import { popoutPage, popoutToken } from '../internal/popout-record'
import { webextSidePanel } from '../sidePanel'
import { call, convert, fail, id, options } from './common'
import { manager, request } from './manager'

export type { ErrorCode, Unsubscribe } from '../internal/errors'
export type {
  OriginalUiClose,
  PopoutBounds,
  PopoutHandle,
  PopoutOptions,
  PopoutTab,
} from './types'

export { WebextError, isWebextError } from '../internal/errors'

function handle(
  record: Ready,
  originalUiClose: OriginalUiClose = { status: 'not-requested' }
): PopoutHandle {
  const associated = () => {
    if (record.associatedTabId === undefined)
      fail('CONTEXT_UNAVAILABLE', 'Popout has no associated tab')
    return record.associatedTabId
  }
  const getTab = async (): Promise<PopoutTab> => {
    const tab = object(await call(['tabs', 'get'], associated()))
    if (!tab || tab.id !== record.associatedTabId || !validId(tab.windowId))
      fail('NATIVE_ERROR', 'Invalid native tab')
    return Object.freeze({ ...tab }) as unknown as PopoutTab
  }
  return Object.freeze({
    windowId: record.windowId,
    source: record.source,
    page: record.page,
    ...(record.associatedTabId === undefined
      ? {}
      : { associatedTabId: record.associatedTabId }),
    ...(record.options.sourceTarget
      ? { sourceTarget: Object.freeze({ ...record.options.sourceTarget }) }
      : {}),
    ...(record.options.reuseKey === undefined
      ? {}
      : { reuseKey: record.options.reuseKey }),
    bounds: Object.freeze({ ...record.bounds }),
    options: Object.freeze({
      ...record.options,
      ...(record.options.sourceTarget
        ? { sourceTarget: Object.freeze({ ...record.options.sourceTarget }) }
        : {}),
    }),
    originalUiClose: Object.freeze(originalUiClose),
    async close() {
      await request('close', { windowId: record.windowId, token: record.token })
    },
    getTab,
    async tabExists() {
      if (record.associatedTabId === undefined) return false
      try {
        await getTab()
        return true
      } catch (error) {
        if (convert(error).code === 'TAB_NOT_FOUND') return false
        throw error
      }
    },
    async activateTab() {
      const tab = await getTab()
      await call(['tabs', 'update'], tab.id, { active: true })
      // Resolve again after activation in case the tab moved concurrently.
      const latest = await getTab()
      await call(['windows', 'update'], latest.windowId, { focused: true })
    },
    messageTarget(value = {}) {
      const v = object(value)
      if (
        !v ||
        Object.keys(v).some(
          (k) => !['world', 'frameId', 'documentId'].includes(k)
        ) ||
        (v.world !== undefined &&
          v.world !== 'MAIN' &&
          v.world !== 'ISOLATED') ||
        (v.documentId !== undefined &&
          (typeof v.documentId !== 'string' || !v.documentId))
      )
        fail('INVALID_ARGUMENT', 'Invalid message target options')
      if (v.frameId !== undefined) id(v.frameId)
      return {
        context: 'content-script' as const,
        tabId: associated(),
        world: (v.world ?? 'ISOLATED') as 'ISOLATED' | 'MAIN',
        ...(v.documentId === undefined
          ? { frameId: (v.frameId ?? 0) as number }
          : {
              documentId: v.documentId as string,
              ...(v.frameId === undefined
                ? {}
                : { frameId: v.frameId as number }),
            }),
      }
    },
  })
}

async function closeOriginal(
  context: ContextInfo | undefined,
  source: PopoutOptions['source']
): Promise<OriginalUiClose> {
  if (
    !context ||
    (source === 'popup'
      ? context.kind !== 'popup'
      : context.kind !== 'side-panel')
  )
    return { status: 'unsupported' }
  try {
    if (source === 'popup') {
      if (typeof globalThis.window?.close !== 'function')
        return { status: 'unsupported' }
      globalThis.window.close()
      return globalThis.window.closed
        ? { status: 'closed' }
        : { status: 'unsupported' }
    }
    // A tab-specific panel must not accidentally close a global panel.
    if (context.tabId !== undefined)
      await webextSidePanel.close({ tabId: context.tabId })
    else if (
      context.windowId !== undefined &&
      webextSidePanel.getCapabilities().close.window
    )
      await webextSidePanel.close({ windowId: context.windowId })
    else if (context.windowId !== undefined) {
      const active = object(await call(['windows', 'getLastFocused']))
      if (active?.id !== context.windowId) return { status: 'unsupported' }
      await webextSidePanel.close()
    } else return { status: 'unsupported' }
    return { status: 'closed' }
  } catch (cause) {
    const error = convert(cause)
    return error.code === 'UNSUPPORTED_OPERATION'
      ? { status: 'unsupported' }
      : { status: 'failed', error }
  }
}

async function open(value: PopoutOptions): Promise<PopoutHandle> {
  const opts = options(value)
  let context: ContextInfo | undefined
  let originalFailure: OriginalUiClose | undefined
  if (opts.closeOriginal) {
    try {
      context = await webextContext.resolve()
    } catch (cause) {
      originalFailure = { status: 'failed', error: convert(cause) }
    }
  }
  const record = await request('open', opts)
  if (!record) fail('NATIVE_ERROR', 'Popout creation returned no record')
  return handle(
    record,
    originalFailure ??
      (opts.closeOriginal
        ? await closeOriginal(context, opts.source)
        : undefined)
  )
}
async function get(windowId: number): Promise<PopoutHandle | undefined> {
  id(windowId)
  const record = await request('get', { windowId })
  return record ? handle(record) : undefined
}
async function getCurrent(): Promise<PopoutHandle | undefined> {
  if (
    !globalThis.window ||
    globalThis.window.top !== globalThis.window ||
    !globalThis.location
  )
    return undefined
  const url = new URL(globalThis.location.href)
  const base = parseUrl(nativeMethod('runtime', 'getURL')?.(''))
  if (!base || !isExtensionUrl(url, base)) return undefined
  const token = popoutToken(url)
  if (!token) return undefined
  const tab = object(await call(['tabs', 'getCurrent']))
  if (!validId(tab?.id) || !validId(tab.windowId)) return undefined
  const record = await request('get', { windowId: tab.windowId })
  return record &&
    record.token === token &&
    record.tabId === tab.id &&
    record.page === popoutPage(url)
    ? handle(record)
    : undefined
}
async function close(windowId: number): Promise<void> {
  id(windowId)
  await request('close', { windowId })
}
function startBackground(): Unsubscribe {
  return manager.startBackground()
}

export const webextPopout = Object.freeze({
  open,
  get,
  getCurrent,
  close,
  startBackground,
})
