import type { ErrorCode, Unsubscribe } from '../internal/errors'
import type { PopoutRecord } from '../internal/popout-record'
import type { PopoutBounds, PopoutOptions } from './types'

import { webextContext } from '../context'
import { WebextError } from '../internal/errors'
import { isExtensionUrl, parseUrl } from '../internal/extension-url'
import { nativeMethod, object, validId } from '../internal/native'
import {
  POPOUT_KEY_PREFIX,
  POPOUT_PARAM,
  popoutPage,
  popoutToken,
} from '../internal/popout-record'
import { Environment } from '../messaging/environment'
import { Realm } from '../messaging/realm'
import { currentRealm } from '../messaging/shared'
import { webextSidePanel } from '../sidePanel'
import { call, convert, fail, id, options, page, root } from './common'

const TOKEN = /^[\w-]{16,128}$/
const RPC = '__webext_utils__popout_rpc_v1'
type Saved = Omit<PopoutRecord, 'status' | 'windowId' | 'tabId'> & {
  status: 'pending' | 'ready'
  windowId?: number
  tabId?: number
  options: PopoutOptions
  bounds: PopoutBounds
}
export type Ready = Saved & { status: 'ready'; windowId: number; tabId: number }
const key = (token: string) => `${POPOUT_KEY_PREFIX}${token}`

function saved(value: unknown, name: string): Saved | undefined {
  const v = object(value)
  if (
    !v ||
    v.version !== 1 ||
    typeof v.token !== 'string' ||
    !TOKEN.test(v.token) ||
    name !== key(v.token) ||
    !['pending', 'ready'].includes(String(v.status))
  )
    return undefined
  try {
    const opts = options(v.options)
    if (
      v.page !== page(v.page) ||
      v.source !== opts.source ||
      opts.page !== v.page ||
      v.associatedTabId !== opts.associatedTabId ||
      !object(v.bounds)
    )
      return undefined
    if (v.status === 'ready' && (!validId(v.windowId) || !validId(v.tabId)))
      return undefined
    return v as unknown as Saved
  } catch {
    return undefined
  }
}
function bounds(window: Record<string, unknown>): PopoutBounds {
  return Object.fromEntries(
    ['width', 'height', 'left', 'top']
      .filter((k) => Number.isSafeInteger(window[k]))
      .map((k) => [k, window[k]])
  )
}

/** Background is the only writer. One Web Lock covers recovery, reuse and events. */
export class PopoutManager {
  private started = false
  private records = new Map<string, Saved>()
  private reconciled = false
  async locked<T>(work: () => Promise<T>): Promise<T> {
    const locks = globalThis.navigator?.locks
    if (!locks)
      fail('UNSUPPORTED_OPERATION', 'Popout management requires Web Locks')
    return await locks.request(`${POPOUT_KEY_PREFIX}manager`, work)
  }
  private async write(record: Saved): Promise<void> {
    await call(['storage', 'session', 'set'], { [key(record.token)]: record })
    this.records.set(record.token, record)
  }
  private async remove(token: string): Promise<void> {
    await call(['storage', 'session', 'remove'], key(token))
    this.records.delete(token)
  }
  async reconcile(attempt = 0): Promise<Ready[]> {
    const entries = object(await call(['storage', 'session', 'get'], null))
    if (!entries) fail('NATIVE_ERROR', 'Invalid native state')
    this.records.clear()
    for (const [name, value] of Object.entries(entries)) {
      if (!name.startsWith(POPOUT_KEY_PREFIX)) continue
      const record = saved(value, name)
      if (record) this.records.set(record.token, record)
      else await call(['storage', 'session', 'remove'], name)
    }
    const windows = await call(['windows', 'getAll'], { populate: true })
    if (!Array.isArray(windows)) fail('NATIVE_ERROR', 'Invalid native state')
    const live = windows.map(object).filter((w) => !!w)
    const records: Ready[] = []
    for (const record of this.records.values()) {
      const matches: {
        window: Record<string, unknown>
        tab: Record<string, unknown>
      }[] = []
      for (const window of live) {
        if (
          window.type !== 'popup' ||
          !validId(window.id) ||
          !Array.isArray(window.tabs)
        )
          continue
        for (const item of window.tabs) {
          const tab = object(item),
            url = parseUrl(tab?.url)
          if (
            tab &&
            validId(tab.id) &&
            tab.windowId === window.id &&
            url &&
            isExtensionUrl(url, root()) &&
            popoutToken(url) === record.token &&
            popoutPage(url) === record.page
          )
            matches.push({ window, tab })
        }
      }
      // Firefox may return a newly created popup before its initial navigation
      // leaves about:blank. A loading placeholder is not proof of navigation away.
      if (
        !matches.length &&
        live.some(
          (w) =>
            w.type === 'popup' &&
            (record.status === 'pending' || w.id === record.windowId) &&
            Array.isArray(w.tabs) &&
            w.tabs.some((item) => {
              const tab = object(item)
              return (
                tab &&
                (record.status === 'pending' || tab.id === record.tabId) &&
                tab.status === 'loading' &&
                (tab.url === 'about:blank' ||
                  tab.url === '' ||
                  tab.url === undefined)
              )
            })
        )
      ) {
        if (attempt >= 40)
          fail(
            'CONTEXT_UNAVAILABLE',
            'Popout initial navigation is still loading'
          )
        await new Promise((resolve) => setTimeout(resolve, 25))
        return await this.reconcile(attempt + 1)
      }
      if (record.status === 'pending') {
        if (matches.length > 1)
          fail('INVALID_ARGUMENT', 'Pending popout has multiple live matches')
        const match = matches[0]
        if (!match) {
          await this.remove(record.token)
          continue
        }
        const ready: Ready = {
          ...record,
          status: 'ready',
          windowId: match.window.id as number,
          tabId: match.tab.id as number,
          bounds: bounds(match.window),
        }
        await this.write(ready)
        records.push(ready)
      } else {
        const match = matches.find(
          (m) => m.window.id === record.windowId && m.tab.id === record.tabId
        )
        if (!match) {
          await this.remove(record.token)
          continue
        }
        records.push({
          ...record,
          status: 'ready',
          windowId: record.windowId!,
          tabId: record.tabId!,
          bounds: bounds(match.window),
        })
      }
    }
    this.reconciled = true
    return records
  }
  private async resolvePage(
    opts: PopoutOptions
  ): Promise<PopoutOptions & { page: string }> {
    if (opts.page !== undefined) return { ...opts, page: page(opts.page) }
    let target = opts.sourceTarget
    const firefox = !!nativeMethod('sidebarAction', 'getPanel')
    if (!firefox && target?.windowId !== undefined) {
      const tabs = await call(['tabs', 'query'], {
        active: true,
        windowId: target.windowId,
      })
      const tab =
        Array.isArray(tabs) && tabs.length === 1 ? object(tabs[0]) : undefined
      if (!validId(tab?.id))
        fail(
          'CONTEXT_UNAVAILABLE',
          'No active tab in source window; specify page'
        )
      target = { tabId: tab.id }
    }
    let value: unknown
    if (opts.source === 'popup') {
      value = nativeMethod('action', 'getPopup')
        ? await call(['action', 'getPopup'], target ?? {})
        : object(object(await call(['runtime', 'getManifest']))?.action)
            ?.default_popup
    } else if (
      nativeMethod('sidePanel', 'getOptions') ||
      nativeMethod('sidebarAction', 'getPanel')
    ) {
      // Respect disabled Chrome panels without changing their configuration.
      if (nativeMethod('sidePanel', 'getOptions')) {
        const settings = object(
          await call(['sidePanel', 'getOptions'], target ?? {})
        )
        if (!settings) fail('NATIVE_ERROR', 'Invalid panel settings')
        if (settings.enabled === false)
          fail('CONTEXT_UNAVAILABLE', 'Source panel is disabled; specify page')
      }
      value = await webextSidePanel.getPage(target)
    } else {
      const manifest = object(await call(['runtime', 'getManifest']))
      value =
        object(manifest?.side_panel)?.default_path ??
        object(manifest?.sidebar_action)?.default_panel
    }
    if (value === undefined || value === '')
      fail(
        'CONTEXT_UNAVAILABLE',
        'Source UI has no page; specify page explicitly'
      )
    return {
      ...opts,
      ...(target ? { sourceTarget: target } : {}),
      page: page(value),
    }
  }
  async open(value: unknown): Promise<Ready> {
    const opts = options(value)
    return await this.locked(async () => {
      const resolved = await this.resolvePage(opts)
      const records = await this.reconcile()
      if (resolved.reuseKey !== undefined) {
        const existing = records.filter(
          (r) => r.options.reuseKey === resolved.reuseKey
        )
        if (existing.length > 1)
          fail('INVALID_ARGUMENT', 'Duplicate reuseKey records')
        const record = existing[0]
        if (record) {
          if (
            record.source !== resolved.source ||
            record.page !== resolved.page ||
            record.associatedTabId !== resolved.associatedTabId
          )
            fail('INVALID_ARGUMENT', 'reuseKey configuration differs')
          await call(['windows', 'update'], record.windowId, { focused: true })
          return record
        }
      }
      // Preflight before the first persistent mutation.
      for (const path of [
        ['windows', 'create'],
        ['windows', 'remove'],
        ['storage', 'session', 'set'],
        ['storage', 'session', 'remove'],
      ])
        if (!nativeMethod(...path))
          fail('UNSUPPORTED_OPERATION', `Missing ${path.join('.')}`)
      const token = crypto.randomUUID()
      const requested = {
        width: resolved.width ?? 480,
        height: resolved.height ?? 720,
        ...(resolved.left === undefined ? {} : { left: resolved.left }),
        ...(resolved.top === undefined ? {} : { top: resolved.top }),
      }
      const record: Saved = {
        version: 1,
        status: 'pending',
        token,
        source: resolved.source,
        page: resolved.page,
        options: resolved,
        bounds: requested,
        ...(resolved.associatedTabId === undefined
          ? {}
          : { associatedTabId: resolved.associatedTabId }),
      }
      await this.write(record)
      const url = new URL(record.page)
      url.searchParams.set(POPOUT_PARAM, token)
      let created: Record<string, unknown> | undefined
      try {
        created = object(
          await call(['windows', 'create'], {
            type: 'popup',
            url: url.href,
            ...requested,
            focused: resolved.focused ?? true,
          })
        )
        if (!validId(created?.id))
          fail('NATIVE_ERROR', 'Window creation returned no ID')
        const tabs = Array.isArray(created.tabs)
          ? created.tabs
          : await call(['tabs', 'query'], { windowId: created.id })
        const tab =
          Array.isArray(tabs) && tabs.length === 1 ? object(tabs[0]) : undefined
        if (!validId(tab?.id))
          fail('NATIVE_ERROR', 'Window creation returned no unique tab')
        const ready: Ready = {
          ...record,
          status: 'ready',
          windowId: created.id,
          tabId: tab.id,
          bounds: bounds(created),
        }
        await this.write(ready)
        return ready
      } catch (cause) {
        try {
          if (validId(created?.id))
            await call(['windows', 'remove'], created.id)
          await this.remove(token)
        } catch (compensation) {
          throw new WebextError(
            'NATIVE_ERROR',
            'popout.open',
            'Creation failed and compensation failed',
            {
              cause,
              details: {
                windowId: created?.id,
                compensation: convert(compensation),
              },
            }
          )
        }
        throw convert(cause)
      }
    })
  }
  async get(windowId: number): Promise<Ready | undefined> {
    id(windowId)
    return await this.locked(async () =>
      (await this.reconcile()).find((r) => r.windowId === windowId)
    )
  }
  async close(windowId: number, token?: string): Promise<void> {
    id(windowId)
    await this.locked(async () => {
      const record = (await this.reconcile()).find(
        (r) =>
          r.windowId === windowId && (token === undefined || r.token === token)
      )
      if (!record) return
      try {
        await call(['windows', 'remove'], windowId)
      } catch (error) {
        if (convert(error).code !== 'WINDOW_NOT_FOUND') throw error
      }
      await this.remove(record.token)
    })
  }
  async request(operation: string, value: unknown): Promise<Ready | undefined> {
    if (operation === 'open') return await this.open(value)
    const v = object(value)
    id(v?.windowId)
    if (operation === 'get') return await this.get(v.windowId)
    if (operation === 'close') {
      await this.close(
        v.windowId,
        typeof v.token === 'string' ? v.token : undefined
      )
      return
    }
    return fail('INVALID_ARGUMENT', 'Unknown popout operation')
  }
  startBackground(): Unsubscribe {
    if (webextContext.get().kind !== 'background')
      fail('CONTEXT_UNAVAILABLE', 'Register popout management in Background')
    if (this.started)
      fail('INVALID_ARGUMENT', 'Popout Background already registered')
    const stops: Unsubscribe[] = []
    try {
      stops.push(
        currentRealm().on(
          {},
          RPC,
          async (value, sender) => {
            const url = parseUrl(sender.url)
            if (sender.id !== new Environment().value('runtime', 'id'))
              fail('ACCESS_DENIED', 'Foreign extension sender')
            if (
              sender.trust !== 'extension' ||
              sender.context !== 'extension-page' ||
              !url ||
              !isExtensionUrl(url, root())
            )
              fail(
                'ACCESS_DENIED',
                'Popout RPC requires a native extension-page sender'
              )
            const v = object(value)
            if (
              !v ||
              typeof v.operation !== 'string' ||
              Object.keys(v).some((k) => !['operation', 'value'].includes(k))
            )
              fail('INVALID_ARGUMENT', 'Invalid popout request')
            try {
              const result = await this.request(v.operation, v.value)
              return {
                ok: true,
                ...(result === undefined ? {} : { value: result }),
              }
            } catch (cause) {
              const error = convert(cause)
              const describe = (value: unknown) => {
                const e = convert(value)
                return { code: e.code, message: e.message }
              }
              return {
                ok: false,
                error: {
                  code: error.code,
                  message: error.message,
                  ...(error.cause === undefined
                    ? {}
                    : { cause: describe(error.cause) }),
                  ...(error.details === undefined
                    ? {}
                    : {
                        details: {
                          ...(validId(error.details.windowId)
                            ? { windowId: error.details.windowId }
                            : {}),
                          ...(error.details.compensation === undefined
                            ? {}
                            : {
                                compensation: describe(
                                  error.details.compensation
                                ),
                              }),
                        },
                      }),
                },
              }
            }
          },
          true
        )
      )
      let queued = false,
        dirty = false
      let active = true
      stops.push(() => {
        active = false
      })
      const cleanup = () => {
        dirty = true
        if (queued) return
        queued = true
        void (async () => {
          try {
            while (dirty && active) {
              dirty = false
              await this.locked(async () => {
                if (active) await this.reconcile()
              })
            }
          } catch {
            /* Retried on next read; never discard state after native failure. */
          } finally {
            queued = false
          }
        })()
      }
      const relevant = (id: unknown, window = false) =>
        !this.reconciled ||
        [...this.records.values()].some(
          (r) =>
            r.status === 'pending' || (window ? r.windowId : r.tabId) === id
        )
      const events: [string[], (...args: unknown[]) => void][] = [
        [
          ['windows', 'onRemoved'],
          (id) => {
            if (relevant(id, true)) cleanup()
          },
        ],
        [
          ['tabs', 'onRemoved'],
          (id) => {
            if (relevant(id)) cleanup()
          },
        ],
        [
          ['tabs', 'onUpdated'],
          (id, change) => {
            const info = object(change)
            if (
              info &&
              (info.url !== undefined || info.status !== undefined) &&
              relevant(id)
            )
              cleanup()
          },
        ],
        [
          ['tabs', 'onAttached'],
          (id) => {
            if (relevant(id)) cleanup()
          },
        ],
      ]
      for (const [path, listener] of events) {
        const add = nativeMethod(...path, 'addListener'),
          remove = nativeMethod(...path, 'removeListener')
        if (!add || !remove)
          fail('UNSUPPORTED_OPERATION', `Missing ${path.join('.')}`)
        add(listener)
        stops.push(() => {
          remove(listener)
        })
      }
      this.started = true
      cleanup()
    } catch (cause) {
      for (const stop of stops.reverse()) stop()
      throw convert(cause)
    }
    return () => {
      if (!this.started) return
      this.started = false
      for (const stop of stops.reverse()) stop()
    }
  }
}
export const manager = new PopoutManager()
export async function request(
  operation: string,
  value: unknown
): Promise<Ready | undefined> {
  const context = webextContext.get()
  if (context.kind === 'background')
    return await manager.request(operation, value)
  const base = root()
  const url = parseUrl(globalThis.location?.href)
  if (!url || !isExtensionUrl(url, base) || !globalThis.document)
    fail('ACCESS_DENIED', 'Popout management requires an extension page')
  // A pending token page cannot yet be classified as popout. The native own
  // extension URL proves eligibility to call this service, not popout ownership.
  // Use the existing messaging transport with this narrow service-only context.
  const env = new Environment()
  env.context = {
    get: () => ({ kind: 'extension-page', source: 'native' }),
    resolve: async () => ({ kind: 'extension-page', source: 'native' }),
  }
  const response = object(
    await new Realm(env).send(
      RPC,
      { operation, value },
      { target: { context: 'background' } },
      'send',
      new Set(),
      false,
      true
    )
  )
  if (response?.ok === true) return response.value as Ready | undefined
  const error = object(response?.error)
  if (
    response?.ok !== false ||
    !error ||
    typeof error.code !== 'string' ||
    typeof error.message !== 'string'
  )
    fail('NATIVE_ERROR', 'Invalid popout service reply')
  throw new WebextError(error.code as ErrorCode, 'popout', error.message, {
    ...(error.cause === undefined ? {} : { cause: error.cause }),
    ...(object(error.details) ? { details: object(error.details)! } : {}),
  })
}
