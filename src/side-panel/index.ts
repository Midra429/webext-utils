/**
 * Chrome の `sidePanel` と Firefox の `sidebarAction` を同じ動作で扱うモジュールです。
 *
 * @module
 */
import type { ErrorCode } from '../internal/errors'
import type { Subscription, Unsubscribe } from '../internal/types'
import type {
  SidePanelBackgroundOptions,
  SidePanelEvent,
  SidePanelListener,
  SidePanelWindowOptions,
} from './types'

import { webextContext } from '../context'
import {
  nativeMethod,
  nativeValue,
  object,
  property,
  validId,
} from '../internal/browser'
import {
  WebextError,
  classifyNativeError,
  isWebextError,
} from '../internal/errors'
import { isExtensionUrl, parseUrl } from '../internal/url'

export type { ErrorCode, WebextErrorOptions } from '../internal/errors'
export type { Subscription, Unsubscribe } from '../internal/types'
export type {
  SidePanelBackgroundOptions,
  SidePanelEvent,
  SidePanelListener,
  SidePanelWindowOptions,
} from './types'

export { WebextError, isWebextError } from '../internal/errors'

const PROTOCOL = '@midra/webext-utils/side-panel'

type Native = 'chrome' | 'firefox'

function fail(code: ErrorCode, operation: string, message: string): never {
  throw new WebextError(code, `sidePanel.${operation}`, message)
}

function convert(operation: string, cause: unknown): WebextError {
  if (isWebextError(cause)) return cause
  const message = cause instanceof Error ? cause.message : String(cause)
  return new WebextError(
    classifyNativeError(cause),
    `sidePanel.${operation}`,
    message,
    { cause }
  )
}

function root(operation: string): URL {
  const url = parseUrl(nativeMethod('runtime', 'getURL')?.(''))
  if (!url || !isExtensionUrl(url, url))
    fail('CONTEXT_UNAVAILABLE', operation, 'Extension runtime is unavailable')
  return url
}

/** Selects the native API. Chrome exposes `sidePanel`, Firefox `sidebarAction`. */
function native(operation: string): Native {
  root(operation)
  if (nativeMethod('sidePanel', 'open')) return 'chrome'
  if (nativeMethod('sidebarAction', 'open')) return 'firefox'
  return fail(
    'UNSUPPORTED_OPERATION',
    operation,
    'Side panel API is unavailable. Check the manifest (side_panel / sidebar_action) and permissions.'
  )
}

function call(
  operation: string,
  path: string[],
  ...args: unknown[]
): Promise<unknown> {
  const method = nativeMethod(...path)
  if (!method)
    fail('UNSUPPORTED_OPERATION', operation, `Missing ${path.join('.')}`)
  try {
    return Promise.resolve(method(...args)).catch((cause) => {
      throw convert(operation, cause)
    })
  } catch (cause) {
    return Promise.reject(convert(operation, cause))
  }
}

function windowOptions(value: unknown, operation: string): number | undefined {
  if (value === undefined) return undefined
  const options = object(value)
  if (
    !options ||
    Object.keys(options).some((key) => key !== 'windowId') ||
    (options.windowId !== undefined && !validId(options.windowId))
  )
    fail(
      'INVALID_ARGUMENT',
      operation,
      'Expected { windowId?: number } with a nonnegative integer'
    )
  return options.windowId as number | undefined
}

async function focusedWindow(operation: string): Promise<number> {
  const window = object(await call(operation, ['windows', 'getLastFocused']))
  if (!validId(window?.id))
    fail('CONTEXT_UNAVAILABLE', operation, 'No browser window is focused')
  return window.id
}

/** Resolves a relative or absolute page to an absolute URL of this extension. */
function pageUrl(value: unknown, operation: string, fromNative = false): URL {
  const base = root(operation)
  let url: URL | undefined
  if (typeof value === 'string' && value.trim()) {
    try {
      url = new URL(value, base)
    } catch {
      /* Rejected below. */
    }
  }
  if (!url || !isExtensionUrl(url, base))
    fail(
      fromNative ? 'UNSUPPORTED_OPERATION' : 'INVALID_ARGUMENT',
      operation,
      'Side panel page must belong to this extension'
    )
  return url
}

function manifestPage(operation: string): URL {
  const manifest = object(nativeMethod('runtime', 'getManifest')?.())
  const path =
    object(manifest?.side_panel)?.default_path ??
    object(manifest?.sidebar_action)?.default_panel
  if (typeof path !== 'string' || !path)
    fail(
      'CONTEXT_UNAVAILABLE',
      operation,
      'The manifest does not define a default side panel page'
    )
  return pageUrl(path, operation, true)
}

/* -------------------------------------------------------------------------- */
/* Open state                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Background-only cache of windows whose panel is open (Chrome). It lets an
 * action click toggle synchronously, inside the user gesture.
 */
let openWindows: Set<number> | undefined

async function chromeIsOpen(windowId: number): Promise<boolean> {
  const contexts = await call('isOpen', ['runtime', 'getContexts'], {
    contextTypes: ['SIDE_PANEL'],
    windowIds: [windowId],
  })
  if (!Array.isArray(contexts))
    fail('NATIVE_ERROR', 'isOpen', 'Invalid runtime.getContexts result')
  return contexts.some((context) => object(context)?.windowId === windowId)
}

function chromeChange(
  operation: 'open' | 'close',
  windowId: number
): Promise<void> {
  return call(operation, ['sidePanel', operation], { windowId }).then(() => {
    if (operation === 'open') openWindows?.add(windowId)
    else openWindows?.delete(windowId)
  })
}

/**
 * Opens or closes the panel. Firefox calls the native API synchronously so the
 * user gesture is kept; Chrome resolves the window first when it is omitted.
 */
function change(
  operation: 'open' | 'close' | 'toggle',
  options?: SidePanelWindowOptions
): Promise<void> {
  try {
    const windowId = windowOptions(options, operation)
    if (native(operation) === 'firefox')
      return call(operation, ['sidebarAction', operation]).then(() => {})
    if (windowId !== undefined && operation !== 'toggle')
      return chromeChange(operation, windowId)
    if (windowId !== undefined && openWindows)
      return chromeChange(
        openWindows.has(windowId) ? 'close' : 'open',
        windowId
      )
    return (async () => {
      const id = windowId ?? (await focusedWindow(operation))
      const next =
        operation !== 'toggle'
          ? operation
          : (await chromeIsOpen(id))
            ? 'close'
            : 'open'
      await chromeChange(next, id)
    })()
  } catch (cause) {
    return Promise.reject(convert(operation, cause))
  }
}

/**
 * サイドパネルを開きます。
 *
 * **ユーザー操作（クリック・キーボードショートカット・コンテキストメニューなど）の処理内で、
 * `await` を挟まずに呼び出してください。** ブラウザはユーザー操作の外での開閉を拒否します
 * （`USER_GESTURE_REQUIRED`）。
 *
 * 既に開いている場合は何もしません。
 *
 * @param options 対象ウィンドウ。省略時はユーザーが操作中のウィンドウ
 * @throws {WebextError} `USER_GESTURE_REQUIRED` / `UNSUPPORTED_OPERATION` / `WINDOW_NOT_FOUND` など
 *
 * @example
 * ```ts
 * button.addEventListener('click', () => {
 *   webextSidePanel.open().catch(console.error)
 * })
 * ```
 */
function open(options?: SidePanelWindowOptions): Promise<void> {
  return change('open', options)
}

/**
 * サイドパネルを閉じます。
 *
 * {@link open} と同じく、ユーザー操作の処理内で呼び出してください。
 * 既に閉じている場合は何もしません。
 *
 * @param options 対象ウィンドウ。省略時はユーザーが操作中のウィンドウ
 */
function close(options?: SidePanelWindowOptions): Promise<void> {
  return change('close', options)
}

/**
 * サイドパネルが開いていれば閉じ、閉じていれば開きます。
 *
 * {@link open} と同じく、ユーザー操作の処理内で呼び出してください。
 *
 * @param options 対象ウィンドウ。省略時はユーザーが操作中のウィンドウ
 */
function toggle(options?: SidePanelWindowOptions): Promise<void> {
  return change('toggle', options)
}

/**
 * このウィンドウでサイドパネル（この拡張機能のパネル）が開いているかを返します。
 *
 * ユーザー操作は不要です。
 *
 * @param options 対象ウィンドウ。省略時は最後にフォーカスされたウィンドウ
 *
 * @example
 * ```ts
 * if (await webextSidePanel.isOpen()) console.log('opened')
 * ```
 */
async function isOpen(options?: SidePanelWindowOptions): Promise<boolean> {
  try {
    const kind = native('isOpen')
    const windowId =
      windowOptions(options, 'isOpen') ?? (await focusedWindow('isOpen'))
    if (kind === 'chrome') return await chromeIsOpen(windowId)
    const result = await call('isOpen', ['sidebarAction', 'isOpen'], {
      windowId,
    })
    if (typeof result !== 'boolean')
      fail('NATIVE_ERROR', 'isOpen', 'Invalid native sidebar state')
    return result
  } catch (cause) {
    throw convert('isOpen', cause)
  }
}

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

async function writePage(url: URL, operation: string): Promise<void> {
  if (native(operation) === 'chrome')
    await call(operation, ['sidePanel', 'setOptions'], {
      path: `${url.pathname.slice(1)}${url.search}${url.hash}`,
      enabled: true,
    })
  else await call(operation, ['sidebarAction', 'setPanel'], { panel: url.href })
}

/**
 * サイドパネルに表示するページを変更します（全ウィンドウ共通）。
 *
 * 開いているパネルにも反映されます。パスは拡張機能のルートからの相対パス、
 * またはこの拡張機能の絶対 URL で指定します。クエリとハッシュは保持します。
 *
 * @param path 例: `'panel.html'`, `'panel.html?view=detail'`
 * @throws {WebextError} 他サイト・他の拡張機能の URL は `INVALID_ARGUMENT`
 *
 * @example
 * ```ts
 * await webextSidePanel.setPage('panel.html?view=settings')
 * ```
 */
async function setPage(path: string): Promise<void> {
  try {
    await writePage(pageUrl(path, 'setPage'), 'setPage')
  } catch (cause) {
    throw convert('setPage', cause)
  }
}

/**
 * サイドパネルに表示するページを Manifest の既定値に戻します。
 *
 * Chrome は `side_panel.default_path`、Firefox は `sidebar_action.default_panel` を使います。
 */
async function resetPage(): Promise<void> {
  try {
    if (native('resetPage') === 'firefox')
      await call('resetPage', ['sidebarAction', 'setPanel'], { panel: null })
    else await writePage(manifestPage('resetPage'), 'resetPage')
  } catch (cause) {
    throw convert('resetPage', cause)
  }
}

/**
 * サイドパネルに表示するページの絶対 URL を返します。
 *
 * パネルが開いているかどうかは表しません（{@link isOpen} を使ってください）。
 *
 * @example
 * ```ts
 * const page = await webextSidePanel.getPage()
 * // 'chrome-extension://<id>/panel.html'
 * ```
 */
async function getPage(): Promise<string> {
  try {
    let path: unknown
    if (native('getPage') === 'chrome') {
      const options = object(
        await call('getPage', ['sidePanel', 'getOptions'], {})
      )
      if (!options)
        fail('NATIVE_ERROR', 'getPage', 'Invalid native panel options')
      path = options.path
    } else path = await call('getPage', ['sidebarAction', 'getPanel'], {})
    if (path === undefined || path === '') return manifestPage('getPage').href
    return pageUrl(path, 'getPage', true).href
  } catch (cause) {
    throw convert('getPage', cause)
  }
}

/* -------------------------------------------------------------------------- */
/* Events                                                                     */
/* -------------------------------------------------------------------------- */

const listeners = {
  opened: new Set<SidePanelListener>(),
  closed: new Set<SidePanelListener>(),
}
let removeNativeListener: (() => void) | undefined

function emit(type: 'opened' | 'closed', event: SidePanelEvent): void {
  for (const listener of [...listeners[type]]) {
    try {
      listener(event)
    } catch {
      /* Listeners are independent. */
    }
  }
}

function eventMessage(value: unknown, sender: unknown) {
  const message = object(value)
  if (message?.protocol !== PROTOCOL || message.version !== 1) return
  const from = object(sender)
  const url = parseUrl(from?.url)
  const base = parseUrl(nativeMethod('runtime', 'getURL')?.(''))
  if (
    !from ||
    from.id !== nativeValue('runtime', 'id') ||
    from.tab !== undefined ||
    !url ||
    !base ||
    !isExtensionUrl(url, base) ||
    (message.type !== 'opened' && message.type !== 'closed') ||
    !validId(message.windowId)
  )
    return
  let page: string
  try {
    page = pageUrl(message.page, 'event', true).href
  } catch {
    return
  }
  return {
    type: message.type as 'opened' | 'closed',
    event: Object.freeze({ windowId: message.windowId, page }),
  }
}

function subscribe(
  type: 'opened' | 'closed',
  listener: SidePanelListener
): Unsubscribe {
  const operation = type === 'opened' ? 'onOpened' : 'onClosed'
  try {
    root(operation)
    if (typeof listener !== 'function')
      fail('INVALID_ARGUMENT', operation, 'Expected a listener function')
    if (!removeNativeListener) {
      const add = nativeMethod('runtime', 'onMessage', 'addListener')
      const remove = nativeMethod('runtime', 'onMessage', 'removeListener')
      if (!add || !remove)
        fail('UNSUPPORTED_OPERATION', operation, 'Missing runtime.onMessage')
      const onMessage = (value: unknown, sender: unknown) => {
        const received = eventMessage(value, sender)
        if (received) emit(received.type, received.event)
      }
      add(onMessage)
      removeNativeListener = () => remove(onMessage)
    }
    const registered = (event: SidePanelEvent) => listener(event)
    listeners[type].add(registered)
    let active = true
    return () => {
      if (!active) return
      active = false
      listeners[type].delete(registered)
      if (!listeners.opened.size && !listeners.closed.size) {
        removeNativeListener?.()
        removeNativeListener = undefined
      }
    }
  } catch (cause) {
    throw convert(operation, cause)
  }
}

/**
 * サイドパネルが開いたときに呼ばれるリスナーを登録します。
 *
 * Background と拡張機能ページ（ポップアップ・タブ・サイドパネル）で使えます。
 * 通知はパネル側のページで {@link registerPanel} を呼び出した場合にだけ発生します
 * （両ブラウザで同じ仕組みを使うため）。
 *
 * @returns リスナーを解除する関数
 *
 * @example
 * ```ts
 * webextSidePanel.onOpened(({ windowId, page }) => {
 *   console.log('opened', windowId, page)
 * })
 * ```
 */
function onOpened(listener: SidePanelListener): Unsubscribe {
  return subscribe('opened', listener)
}

/**
 * サイドパネルが閉じたときに呼ばれるリスナーを登録します。
 *
 * パネルを閉じた・別のパネルに切り替えた・ウィンドウを閉じたなど、
 * パネルのページが破棄されたときに通知されます。条件は {@link onOpened} と同じです。
 *
 * @returns リスナーを解除する関数
 */
function onClosed(listener: SidePanelListener): Unsubscribe {
  return subscribe('closed', listener)
}

let registration: Subscription | undefined

/**
 * 現在のページをサイドパネルとして登録し、開閉を {@link onOpened} / {@link onClosed} に通知します。
 *
 * サイドパネルとして表示する HTML のスクリプトで、読み込み時に一度だけ呼び出してください。
 * ページが破棄される（`pagehide`）と自動的に「閉じた」と通知します。
 *
 * @returns 登録の解除関数。`ready` は「開いた」通知の送信後に解決します。
 *   解除しても「閉じた」通知は送信しません。
 * @throws {WebextError} 拡張機能のページ以外では `CONTEXT_UNAVAILABLE`、二重登録は `INVALID_ARGUMENT`
 *
 * @example
 * ```ts
 * // panel.ts（サイドパネルのページ）
 * import { webextSidePanel } from '@midra/webext-utils/side-panel'
 *
 * webextSidePanel.registerPanel()
 * ```
 */
function registerPanel(): Subscription {
  const operation = 'registerPanel'
  try {
    const base = root(operation)
    const href = property(property(globalThis, 'location'), 'href')
    const url = parseUrl(href)
    const window = property(globalThis, 'window') as
      | {
          addEventListener(type: string, listener: () => void): void
          removeEventListener(type: string, listener: () => void): void
        }
      | undefined
    if (!url || !isExtensionUrl(url, base) || !window)
      fail(
        'CONTEXT_UNAVAILABLE',
        operation,
        'registerPanel must be called in an extension page shown as the side panel'
      )
    if (registration)
      fail('INVALID_ARGUMENT', operation, 'The panel is already registered')
    const send = nativeMethod('runtime', 'sendMessage')
    if (!send)
      fail('UNSUPPORTED_OPERATION', operation, 'Missing runtime.sendMessage')
    const page = url.href
    let windowId: number | undefined
    let active = true
    const announce = (type: 'opened' | 'closed') => {
      if (windowId === undefined) return
      const event = Object.freeze({ windowId, page })
      emit(type, event)
      try {
        void Promise.resolve(
          send({ protocol: PROTOCOL, version: 1, type, windowId, page })
        ).catch(() => {
          // No receiver is listening; read lastError for Chrome callbacks.
          nativeValue('runtime', 'lastError')
        })
      } catch {
        /* The page is being destroyed. */
      }
    }
    const stop = () => {
      if (!active) return
      active = false
      registration = undefined
      window.removeEventListener('pagehide', hide)
    }
    const hide = () => {
      announce('closed')
      stop()
    }
    window.addEventListener('pagehide', hide)
    const ready = (async () => {
      const current = object(await call(operation, ['windows', 'getCurrent']))
      if (!validId(current?.id))
        fail('CONTEXT_UNAVAILABLE', operation, 'The panel has no window')
      if (!active)
        fail('TRANSPORT_CLOSED', operation, 'Registration was removed')
      windowId = current.id
      announce('opened')
    })()
    ready.catch(stop)
    registration = Object.assign(stop, { ready })
    return registration
  } catch (cause) {
    throw convert(operation, cause)
  }
}

/* -------------------------------------------------------------------------- */
/* Background                                                                 */
/* -------------------------------------------------------------------------- */

let background = false

/**
 * Background でサイドパネルの補助機能を開始します。
 *
 * Background のスクリプトの最上位で、最初の `await` より前に同期的に呼び出してください
 * （Service Worker / イベントページの再起動ごとに登録が必要です）。
 *
 * - `openOnActionClick: true` で、拡張機能アイコンのクリックでパネルを開閉します。
 * - Background から {@link toggle} を `windowId` 付きで呼んだときも、ユーザー操作内で開閉できるようになります。
 *
 * @returns 登録を解除する関数
 * @throws {WebextError} Background 以外では `CONTEXT_UNAVAILABLE`、二重登録は `INVALID_ARGUMENT`
 *
 * @example
 * ```ts
 * // background.ts
 * webextSidePanel.startBackground({ openOnActionClick: true })
 * ```
 */
function startBackground(
  options: SidePanelBackgroundOptions = {}
): Unsubscribe {
  const operation = 'startBackground'
  try {
    const value = object(options)
    if (
      !value ||
      Object.keys(value).some(
        (key) => key !== 'openOnActionClick' && key !== 'onError'
      ) ||
      (value.openOnActionClick !== undefined &&
        typeof value.openOnActionClick !== 'boolean') ||
      (value.onError !== undefined && typeof value.onError !== 'function')
    )
      fail('INVALID_ARGUMENT', operation, 'Invalid side panel options')
    if (webextContext.get().kind !== 'background')
      fail(
        'CONTEXT_UNAVAILABLE',
        operation,
        'startBackground must be called in the Background'
      )
    if (background)
      fail(
        'INVALID_ARGUMENT',
        operation,
        'Side panel Background already started'
      )
    const kind = native(operation)
    const stops: (() => void)[] = []
    const listen = (path: string[], listener: (...args: never[]) => void) => {
      const add = nativeMethod(...path, 'addListener')
      const remove = nativeMethod(...path, 'removeListener')
      if (!add || !remove)
        fail('UNSUPPORTED_OPERATION', operation, `Missing ${path.join('.')}`)
      add(listener)
      stops.push(() => remove(listener))
    }
    try {
      if (kind === 'chrome') {
        const windows = new Set<number>()
        openWindows = windows
        stops.push(() => {
          if (openWindows === windows) openWindows = undefined
        })
        const update = (open: boolean) => (info: unknown) => {
          const id = object(info)?.windowId
          if (validId(id)) open ? windows.add(id) : windows.delete(id)
        }
        if (nativeMethod('sidePanel', 'onOpened', 'addListener'))
          listen(['sidePanel', 'onOpened'], update(true))
        if (nativeMethod('sidePanel', 'onClosed', 'addListener'))
          listen(['sidePanel', 'onClosed'], update(false))
        listen(['windows', 'onRemoved'], (id: unknown) => {
          if (validId(id)) windows.delete(id)
        })
        void call(operation, ['runtime', 'getContexts'], {
          contextTypes: ['SIDE_PANEL'],
        })
          .then((contexts) => {
            if (!Array.isArray(contexts)) return
            for (const context of contexts) {
              const id = object(context)?.windowId
              if (validId(id)) windows.add(id)
            }
          })
          .catch(() => {})
      }
      if (value.openOnActionClick === true) {
        const report = (cause: unknown) => {
          try {
            value.onError &&
              (value.onError as (error: WebextError) => void)(
                convert('toggle', cause)
              )
          } catch {
            /* Independent observer. */
          }
        }
        listen(['action', 'onClicked'], (tab: unknown) => {
          const windowId = object(tab)?.windowId
          toggle(validId(windowId) ? { windowId } : undefined).catch(report)
        })
      }
    } catch (cause) {
      for (const stop of stops.reverse()) stop()
      throw cause
    }
    background = true
    let active = true
    return () => {
      if (!active) return
      active = false
      background = false
      for (const stop of stops.reverse()) stop()
    }
  } catch (cause) {
    throw convert(operation, cause)
  }
}

/**
 * サイドパネルを操作します。Chrome の `sidePanel` と Firefox の `sidebarAction` の差を吸収し、
 * どちらのブラウザでも同じ引数で同じ結果になります。
 *
 * | 操作 | 説明 |
 * | --- | --- |
 * | {@link open} / {@link close} / {@link toggle} | 開閉（ユーザー操作内で呼ぶ） |
 * | {@link isOpen} | 開いているか |
 * | {@link setPage} / {@link getPage} / {@link resetPage} | 表示するページ |
 * | {@link registerPanel} | パネル側のページで呼び、開閉を通知する |
 * | {@link onOpened} / {@link onClosed} | 開閉の通知を受け取る |
 * | {@link startBackground} | アイコンのクリックで開閉するなどの Background 機能 |
 *
 * @example
 * ```ts
 * import { webextSidePanel } from '@midra/webext-utils/side-panel'
 *
 * document.querySelector('#open')?.addEventListener('click', () => {
 *   webextSidePanel.open().catch(console.error)
 * })
 * ```
 */
export const webextSidePanel = Object.freeze({
  open,
  close,
  toggle,
  isOpen,
  setPage,
  getPage,
  resetPage,
  registerPanel,
  onOpened,
  onClosed,
  startBackground,
})
