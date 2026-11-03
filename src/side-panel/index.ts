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

/**
 * Chrome reports side panel contexts with `windowId: -1`, so the window of an
 * open panel is asked from the panel pages that called registerPanel().
 */
async function chromeIsOpen(windowId: number): Promise<boolean> {
  if (registeredWindow === windowId || openWindows?.has(windowId)) return true
  const contexts = await call('isOpen', ['runtime', 'getContexts'], {
    contextTypes: ['SIDE_PANEL'],
  })
  if (!Array.isArray(contexts))
    fail('NATIVE_ERROR', 'isOpen', 'Invalid runtime.getContexts result')
  if (!contexts.length) return false
  const ids = contexts.map((context) => object(context)?.windowId)
  if (ids.every(validId)) return ids.includes(windowId)
  try {
    const answer = await call('isOpen', ['runtime', 'sendMessage'], {
      protocol: PROTOCOL,
      version: 1,
      type: 'query',
      windowId,
    })
    return answer === true
  } catch {
    // No registered panel answered.
    return false
  }
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
/**
 * Waits until isOpen() reports the new state. Native calls may resolve before
 * the panel document is created or destroyed (Chrome); this makes open/close
 * complete at the same point in every browser.
 */
async function settle(
  operation: string,
  windowId: number | undefined,
  expected: boolean | undefined
): Promise<void> {
  try {
    const id = windowId ?? (await focusedWindow(operation))
    for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
      const state = await openState(id)
      if (expected === undefined ? true : state === expected) return
      await new Promise((resolve) => setTimeout(resolve, SETTLE_INTERVAL))
    }
  } catch {
    /* The native operation itself succeeded. */
  }
}
const SETTLE_ATTEMPTS = 40
const SETTLE_INTERVAL = 25

/**
 * Opens or closes the panel. The native call starts before any await whenever
 * possible so the user gesture is kept: always in Firefox, and in Chrome when
 * the window (and, for toggle, its state) is known synchronously.
 */
function change(
  operation: 'open' | 'close' | 'toggle',
  options?: SidePanelWindowOptions
): Promise<void> {
  try {
    const windowId = windowOptions(options, operation)
    if (native(operation) === 'firefox') {
      const expected = operation === 'toggle' ? undefined : operation === 'open'
      return call(operation, ['sidebarAction', operation]).then(() =>
        settle(operation, windowId, expected)
      )
    }
    const run = (next: 'open' | 'close', id: number) =>
      chromeChange(next, id).then(() => settle(operation, id, next === 'open'))
    if (windowId !== undefined && operation !== 'toggle')
      return run(operation, windowId)
    if (windowId !== undefined && openWindows)
      return run(openWindows.has(windowId) ? 'close' : 'open', windowId)
    return (async () => {
      const id = windowId ?? (await focusedWindow(operation))
      const next =
        operation !== 'toggle'
          ? operation
          : (await chromeIsOpen(id))
            ? 'close'
            : 'open'
      await run(next, id)
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
 * 既に開いている場合は何もしません。完了した時点で、{@link isOpen} は `true` を返します
 * （ブラウザへの反映を最大 1 秒待ちます）。
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
 * 既に閉じている場合は何もしません。完了した時点で、{@link isOpen} は `false` を返します。
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
 * ユーザー操作は不要です。正しく判定するには、パネル側のページで {@link registerPanel} を
 * 呼び出してください（Chrome はブラウザ API からパネルのウィンドウを取得できないため、
 * パネル自身と Background の {@link startBackground} が状態を答えます）。
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
    native('isOpen')
    const windowId =
      windowOptions(options, 'isOpen') ?? (await focusedWindow('isOpen'))
    return await openState(windowId)
  } catch (cause) {
    throw convert('isOpen', cause)
  }
}

async function openState(windowId: number): Promise<boolean> {
  if (native('isOpen') === 'chrome') return await chromeIsOpen(windowId)
  const result = await call('isOpen', ['sidebarAction', 'isOpen'], {
    windowId,
  })
  if (typeof result !== 'boolean')
    fail('NATIVE_ERROR', 'isOpen', 'Invalid native sidebar state')
  return result
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
/*
 * The Background is the single source of open/close events in every browser:
 * - Chrome: native sidePanel.onOpened / onClosed (they also wake the worker).
 * - Firefox: each registered panel holds one Port to the Background; the Port
 *   disconnects when the panel document is destroyed.
 * The Background then broadcasts the event to every extension page.
 */

type EventType = 'opened' | 'closed'

const listeners = {
  opened: new Set<SidePanelListener>(),
  closed: new Set<SidePanelListener>(),
}
let removeMessageListener: (() => void) | undefined
/** Set while startBackground() is active in this realm. */
let hub: { publish(type: EventType, event: SidePanelEvent): void } | undefined

function emit(type: EventType, event: SidePanelEvent): void {
  for (const listener of [...listeners[type]]) {
    try {
      listener(event)
    } catch {
      /* Listeners are independent. */
    }
  }
}

/** Accepts messages only from this extension's own pages and Background. */
function trusted(sender: unknown): boolean {
  const from = object(sender)
  if (!from || from.id !== nativeValue('runtime', 'id')) return false
  // Content Scripts run on web pages; extension pages (also those in tabs)
  // and the Background have an extension URL.
  const url = parseUrl(from.url)
  const base = parseUrl(nativeMethod('runtime', 'getURL')?.(''))
  return !!url && !!base && isExtensionUrl(url, base)
}

function message(
  value: unknown,
  types: readonly string[]
): { type: string; event: SidePanelEvent } | undefined {
  const data = object(value)
  if (
    data?.protocol !== PROTOCOL ||
    data.version !== 1 ||
    typeof data.type !== 'string' ||
    !types.includes(data.type) ||
    !validId(data.windowId)
  )
    return
  try {
    const page = pageUrl(data.page, 'event', true).href
    return {
      type: data.type,
      event: Object.freeze({ windowId: data.windowId, page }),
    }
  } catch {
    return
  }
}

function subscribe(type: EventType, listener: SidePanelListener): Unsubscribe {
  const operation = type === 'opened' ? 'onOpened' : 'onClosed'
  try {
    root(operation)
    if (typeof listener !== 'function')
      fail('INVALID_ARGUMENT', operation, 'Expected a listener function')
    if (!removeMessageListener) {
      const add = nativeMethod('runtime', 'onMessage', 'addListener')
      const remove = nativeMethod('runtime', 'onMessage', 'removeListener')
      if (!add || !remove)
        fail('UNSUPPORTED_OPERATION', operation, 'Missing runtime.onMessage')
      const onMessage = (value: unknown, sender: unknown) => {
        const received = message(value, ['opened', 'closed'])
        if (received && trusted(sender))
          emit(received.type as EventType, received.event)
      }
      add(onMessage)
      removeMessageListener = () => remove(onMessage)
    }
    const registered = (event: SidePanelEvent) => listener(event)
    listeners[type].add(registered)
    let active = true
    return () => {
      if (!active) return
      active = false
      listeners[type].delete(registered)
      if (!listeners.opened.size && !listeners.closed.size) {
        removeMessageListener?.()
        removeMessageListener = undefined
      }
    }
  } catch (cause) {
    throw convert(operation, cause)
  }
}

/**
 * サイドパネルが開いたときに呼ばれるリスナーを登録します。
 *
 * Background と拡張機能のページ（ポップアップ・タブ・サイドパネル）で使えます。
 * 通知には、Background での {@link startBackground} と、パネル側のページでの
 * {@link registerPanel} が必要です（両ブラウザで同じ仕組みにするため）。
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

/* -------------------------------------------------------------------------- */
/* Panel page                                                                 */
/* -------------------------------------------------------------------------- */

const PORT = `${PROTOCOL}/panel`
/** Minimum lifetime (ms) of a Port before the panel reconnects it. */
const RECONNECT_AFTER = 1000

let registration: Subscription | undefined
/** The window of the panel registered in this page, once known. */
let registeredWindow: number | undefined

/**
 * 現在のページをサイドパネルとして登録します。
 *
 * サイドパネルとして表示する HTML のスクリプトで、読み込み時に一度だけ呼び出してください。
 * 次の機能が、両ブラウザで同じように動くようになります。
 *
 * - {@link onOpened} / {@link onClosed} の通知（Background の {@link startBackground} も必要）
 * - {@link isOpen} / {@link toggle} による開閉状態の判定
 *
 * @returns 登録の解除関数。`ready` はウィンドウを特定して登録が完了すると解決します。
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
    const url = parseUrl(property(property(globalThis, 'location'), 'href'))
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
    const kind = native(operation)
    const addListener = nativeMethod('runtime', 'onMessage', 'addListener')
    const removeListener = nativeMethod(
      'runtime',
      'onMessage',
      'removeListener'
    )
    if (!addListener || !removeListener)
      fail('UNSUPPORTED_OPERATION', operation, 'Missing runtime.onMessage')
    const page = url.href
    let windowId: number | undefined
    let active = true
    let port: Port | undefined

    const send = (type: 'present') => {
      void call(operation, ['runtime', 'sendMessage'], {
        protocol: PROTOCOL,
        version: 1,
        type,
        windowId,
        page,
      }).catch(() => {
        /* The Background is not listening. */
      })
    }
    // Firefox: one Port to the Background. It disconnects when this document
    // is destroyed, which is how the Background observes the panel closing.
    const connect = (type: 'opened' | 'present') => {
      const connectMethod = nativeMethod('runtime', 'connect')
      if (!active || !connectMethod) return
      try {
        const current = connectMethod({ name: PORT }) as Port
        const connectedAt = Date.now()
        port = current
        current.onDisconnect.addListener(() => {
          nativeValue('runtime', 'lastError')
          if (port !== current || !active) return
          port = undefined
          // The Background was stopped while the panel stayed open: reconnect
          // so the restarted Background knows this panel. An immediate
          // disconnect means nothing listens, so do not retry in a loop.
          if (Date.now() - connectedAt >= RECONNECT_AFTER) connect('present')
        })
        current.postMessage({
          protocol: PROTOCOL,
          version: 1,
          type,
          windowId,
          page,
        })
      } catch {
        port = undefined
      }
    }
    // Answers isOpen() queries (Chrome) and state probes from the Background.
    const onMessage = (
      value: unknown,
      sender: unknown,
      respond: unknown
    ): undefined => {
      const data = object(value)
      if (
        data?.protocol !== PROTOCOL ||
        data.version !== 1 ||
        windowId === undefined ||
        !trusted(sender)
      )
        return
      if (data.type === 'probe' && kind === 'chrome') send('present')
      else if (
        data.type === 'query' &&
        data.windowId === windowId &&
        typeof respond === 'function'
      )
        respond(true)
    }
    const stop = () => {
      if (!active) return
      active = false
      registration = undefined
      registeredWindow = undefined
      window.removeEventListener('pagehide', stop)
      removeListener(onMessage)
      const current = port
      port = undefined
      current?.disconnect()
    }
    window.addEventListener('pagehide', stop)
    addListener(onMessage)
    const ready = (async () => {
      const current = object(await call(operation, ['windows', 'getCurrent']))
      if (!validId(current?.id))
        fail('CONTEXT_UNAVAILABLE', operation, 'The panel has no window')
      if (!active)
        fail('TRANSPORT_CLOSED', operation, 'Registration was removed')
      windowId = current.id
      registeredWindow = current.id
      if (kind === 'firefox') connect('opened')
    })()
    ready.catch(stop)
    registration = Object.assign(stop, { ready })
    return registration
  } catch (cause) {
    throw convert(operation, cause)
  }
}

interface Port {
  name: string
  postMessage(message: unknown): void
  disconnect(): void
  onMessage: {
    addListener(listener: (message: unknown) => void): void
    removeListener(listener: (message: unknown) => void): void
  }
  onDisconnect: {
    addListener(listener: () => void): void
    removeListener(listener: () => void): void
  }
}

/* -------------------------------------------------------------------------- */
/* Background                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Background でサイドパネルの機能を開始します。
 *
 * Background のスクリプトの最上位で、最初の `await` より前に同期的に呼び出してください
 * （Service Worker / イベントページの再起動ごとに登録が必要です）。
 *
 * - {@link onOpened} / {@link onClosed} の通知を、すべての拡張機能のページへ配信します。
 * - `openOnActionClick: true` で、拡張機能アイコンのクリックでパネルを開閉します。
 * - Background から {@link toggle} を `windowId` 付きで呼んだときも、ユーザー操作内で開閉できます。
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
    if (hub)
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
    const windows = new Set<number>()
    const current = {
      publish(type: EventType, event: SidePanelEvent) {
        emit(type, event)
        void call(operation, ['runtime', 'sendMessage'], {
          protocol: PROTOCOL,
          version: 1,
          type,
          ...event,
        }).catch(() => {
          /* No extension page is listening. */
        })
      },
    }
    try {
      if (kind === 'chrome') {
        openWindows = windows
        stops.push(() => {
          if (openWindows === windows) openWindows = undefined
        })
        // Chrome's event path drops the query and hash, so the configured
        // page is used to report the same URL as Firefox.
        const pages = new Map<number, string>()
        const nativeEvent = (type: EventType) => (info: unknown) => {
          const data = object(info)
          if (!validId(data?.windowId) || data.tabId !== undefined) return
          const windowId = data.windowId
          if (type === 'closed') {
            windows.delete(windowId)
            const page = pages.get(windowId)
            pages.delete(windowId)
            if (page)
              current.publish('closed', Object.freeze({ windowId, page }))
            return
          }
          windows.add(windowId)
          void getPage()
            .catch(() => pageUrl(data.path, 'event', true).href)
            .then((page) => {
              if (!windows.has(windowId) || pages.has(windowId)) return
              pages.set(windowId, page)
              current.publish('opened', Object.freeze({ windowId, page }))
            })
            .catch(() => {
              /* The native path does not belong to this extension. */
            })
        }
        listen(['sidePanel', 'onOpened'], nativeEvent('opened'))
        listen(['sidePanel', 'onClosed'], nativeEvent('closed'))
        listen(['windows', 'onRemoved'], (id: unknown) => {
          if (validId(id)) windows.delete(id)
        })
        listen(
          ['runtime', 'onMessage'],
          (data: unknown, sender: unknown, respond: unknown) => {
            if (!trusted(sender)) return
            // Registered panels report their window after a worker restart.
            const received = message(data, ['present'])
            if (received) windows.add(received.event.windowId)
            // isOpen() from other pages: only a known open window is answered,
            // so a registered panel can still answer when this state is stale.
            const query = object(data)
            if (
              query?.protocol === PROTOCOL &&
              query.type === 'query' &&
              validId(query.windowId) &&
              windows.has(query.windowId) &&
              typeof respond === 'function'
            )
              respond(true)
          }
        )
        void call(operation, ['runtime', 'sendMessage'], {
          protocol: PROTOCOL,
          version: 1,
          type: 'probe',
        }).catch(() => {
          /* No panel is open. */
        })
      } else {
        listen(['runtime', 'onConnect'], (value: unknown) => {
          const port = value as Port & { sender?: unknown }
          if (object(port)?.name !== PORT) return
          if (!trusted(port.sender)) {
            port.disconnect()
            return
          }
          let event: SidePanelEvent | undefined
          port.onMessage.addListener((data) => {
            const received = message(data, ['opened', 'present'])
            if (!received || event) return
            event = received.event
            if (received.type === 'opened') current.publish('opened', event)
          })
          port.onDisconnect.addListener(() => {
            nativeValue('runtime', 'lastError')
            if (event && hub === current) current.publish('closed', event)
            event = undefined
          })
        })
      }
      if (value.openOnActionClick === true) {
        const report = (cause: unknown) => {
          try {
            ;(value.onError as ((error: WebextError) => void) | undefined)?.(
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
    hub = current
    let active = true
    return () => {
      if (!active) return
      active = false
      if (hub === current) hub = undefined
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
 * | {@link registerPanel} | パネル側のページで呼ぶ（開閉状態の判定・通知に必要） |
 * | {@link onOpened} / {@link onClosed} | 開閉の通知を受け取る |
 * | {@link startBackground} | Background で呼ぶ（開閉の通知・アイコンのクリックでの開閉） |
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
