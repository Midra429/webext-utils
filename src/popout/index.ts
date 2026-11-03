/**
 * ポップアップやサイドパネルと同じ HTML を、独立したウィンドウ（popout）で開くモジュールです。
 *
 * @module
 */
import type { ContextInfo } from '../context'
import type { Unsubscribe } from '../internal/types'
import type { Ready } from './manager'
import type {
  OriginalUiClose,
  PopoutHandle,
  PopoutOptions,
  PopoutTab,
} from './types'

import { webextContext } from '../context'
import { nativeMethod, object, validId } from '../internal/browser'
import { popoutPage, popoutToken } from '../internal/popout-record'
import { isExtensionUrl, parseUrl } from '../internal/url'
import { manager, request } from './manager'
import { call, convert, fail, id, options } from './utils'

export type { ErrorCode, WebextErrorOptions } from '../internal/errors'
export type { Subscription, Unsubscribe } from '../internal/types'
export type {
  OriginalUiClose,
  PopoutBaseOptions,
  PopoutBounds,
  PopoutHandle,
  PopoutMessageTargetOptions,
  PopoutOptions,
  PopoutSource,
  PopoutSourceTarget,
  PopoutTab,
  PopupPopoutOptions,
  SidePanelPopoutOptions,
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
    }) as Readonly<PopoutOptions>,
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

/** Closes the calling Action Popup. Only popups can be closed in every browser. */
function closeOriginal(context: ContextInfo | undefined): OriginalUiClose {
  if (context?.kind !== 'popup') return { status: 'unsupported' }
  try {
    if (typeof globalThis.window?.close !== 'function')
      return { status: 'unsupported' }
    globalThis.window.close()
    return globalThis.window.closed
      ? { status: 'closed' }
      : { status: 'unsupported' }
  } catch (cause) {
    return { status: 'failed', error: convert(cause) }
  }
}

/**
 * popout ウィンドウを開きます。
 *
 * 拡張機能のページと Background から呼び出せます。Background で
 * `webextMessaging.startBackground()` と `webextPopout.startBackground()` の登録が必要です。
 *
 * @throws {WebextError} ページを特定できない場合は `CONTEXT_UNAVAILABLE`、引数が不正なら `INVALID_ARGUMENT`
 *
 * @example
 * ```ts
 * const popout = await webextPopout.open({
 *   source: 'side-panel',
 *   associatedTabId: 42,
 *   reuseKey: 'inspector-42',
 * })
 * console.log(popout.windowId)
 * ```
 */
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
    originalFailure ?? (opts.closeOriginal ? closeOriginal(context) : undefined)
  )
}
/**
 * ウィンドウ ID から popout のハンドルを取得します。
 *
 * @returns このライブラリで開いた popout でなければ `undefined`
 */
async function get(windowId: number): Promise<PopoutHandle | undefined> {
  id(windowId)
  const record = await request('get', { windowId })
  return record ? handle(record) : undefined
}
/**
 * 現在のページが popout として開かれている場合、そのハンドルを返します。
 *
 * ポップアップ・サイドパネルと popout で同じ HTML を使う場合に、表示形態を判別できます。
 *
 * @returns popout でなければ `undefined`
 *
 * @example
 * ```ts
 * const current = await webextPopout.getCurrent()
 * if (current) document.body.classList.add('popout')
 * ```
 */
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
/**
 * popout ウィンドウを閉じます。このライブラリで開いた popout 以外には何もしません。
 */
async function close(windowId: number): Promise<void> {
  id(windowId)
  await request('close', { windowId })
}
/**
 * Background で popout の管理を開始します。
 *
 * Background のスクリプトの最上位で、`webextMessaging.startBackground()` の後、
 * 最初の `await` より前に呼び出してください。
 *
 * @returns 登録を解除する関数
 */
function startBackground(): Unsubscribe {
  return manager.startBackground()
}

/**
 * ポップアップ・サイドパネルと同じ HTML を独立したウィンドウ（popout）で開きます。
 *
 * | 操作 | 説明 |
 * | --- | --- |
 * | {@link open} | popout を開く |
 * | {@link getCurrent} | 現在のページの popout ハンドル |
 * | {@link get} / {@link close} | ウィンドウ ID で取得・閉じる |
 * | {@link startBackground} | Background での管理を開始する |
 *
 * @example
 * ```ts
 * import { webextPopout } from '@midra/webext-utils/popout'
 *
 * await webextPopout.open({ source: 'popup', reuseKey: 'main' })
 * ```
 */
export const webextPopout = Object.freeze({
  open,
  get,
  getCurrent,
  close,
  startBackground,
})
