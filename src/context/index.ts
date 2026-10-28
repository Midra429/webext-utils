import type { Unsubscribe } from '../internal/errors'
import type { ContextInfo, ContextMetadata, ContextRegistration } from './types'

import { WebextError, nativeError } from '../internal/errors'
import { isExtensionUrl, parseUrl } from '../internal/extension-url'
import {
  nativeMethod,
  nativeValue,
  object,
  property,
  validId,
} from '../internal/native'
import { POPOUT_PARAM, readPopoutRecord } from '../internal/popout-record'

export type { ErrorCode, Unsubscribe } from '../internal/errors'
export type {
  ContextInfo,
  ContextMetadata,
  ContextRegistration,
  ContextSource,
} from './types'

export { WebextError, isWebextError } from '../internal/errors'

interface Environment {
  href: string | undefined
  document: unknown
  window: unknown
  own: boolean
  worker: boolean
  isolated: boolean
}

function environment(): Environment {
  const href = property(property(globalThis, 'location'), 'href')
  const document = property(globalThis, 'document')
  const window = property(globalThis, 'window')
  const url = parseUrl(href)
  const root = parseUrl(nativeMethod('runtime', 'getURL')?.(''))
  const hasRuntime =
    typeof nativeValue('runtime', 'id') === 'string' &&
    !!nativeMethod('runtime', 'getManifest') &&
    !!root
  const own = hasRuntime && !!url && !!root && isExtensionUrl(url, root)
  const WorkerScope = property(globalThis, 'ServiceWorkerGlobalScope')
  const worker =
    own &&
    !document &&
    typeof WorkerScope === 'function' &&
    globalThis instanceof WorkerScope
  return {
    href: typeof href === 'string' ? href : undefined,
    document,
    window,
    own,
    worker,
    isolated: hasRuntime && !!document && !!window && !own,
  }
}

function snapshot(env: Environment): ContextInfo {
  if (env.worker)
    return {
      kind: 'background',
      implementation: 'service-worker',
      source: 'native',
    }
  if (env.isolated)
    return { kind: 'content-script', world: 'ISOLATED', source: 'native' }
  if (!env.own || !env.document || !env.window)
    return { kind: 'unknown', source: 'unknown' }
  const url = parseUrl(env.href)
  if (url?.searchParams.has(POPOUT_PARAM))
    return { kind: 'unknown', source: 'unknown' }
  if (nativeMethod('extension', 'getBackgroundPage')?.() === env.window) {
    return { kind: 'background', implementation: 'page', source: 'native' }
  }
  if (validId(nativeValue('devtools', 'inspectedWindow', 'tabId')))
    return { kind: 'devtools', source: 'native' }
  const views = nativeMethod('extension', 'getViews')
  if (views) {
    const popup = views({ type: 'popup' })
    if (Array.isArray(popup) && popup.includes(env.window))
      return { kind: 'popup', source: 'native' }
    // "sidebar" is Firefox-only; do not pass it to Chrome's enum validator.
    if (nativeMethod('sidebarAction', 'open')) {
      const sidebar = views({ type: 'sidebar' })
      if (Array.isArray(sidebar) && sidebar.includes(env.window))
        return { kind: 'side-panel', source: 'native' }
    }
    const tabs = views({ type: 'tab' })
    if (Array.isArray(tabs) && tabs.includes(env.window))
      return { kind: 'extension-page', source: 'native' }
  }
  return { kind: 'unknown', source: 'unknown' }
}

function metadata(context: Record<string, unknown>): ContextMetadata {
  return {
    source: 'native',
    ...(validId(context.tabId) ? { tabId: context.tabId } : {}),
    ...(validId(context.frameId) ? { frameId: context.frameId } : {}),
    ...(validId(context.windowId) ? { windowId: context.windowId } : {}),
    ...(typeof context.documentId === 'string'
      ? { documentId: context.documentId }
      : {}),
    ...(typeof context.contextId === 'string'
      ? { instanceId: context.contextId }
      : {}),
  }
}

function kindOf(
  context: Record<string, unknown>,
  env: Environment
): ContextInfo['kind'] | undefined {
  switch (context.contextType) {
    case 'BACKGROUND':
      return env.worker || env.document ? 'background' : undefined
    case 'POPUP':
      return 'popup'
    case 'SIDE_PANEL':
      return 'side-panel'
    case 'TAB':
      return 'extension-page'
    case 'DEVELOPER_TOOLS':
      return 'devtools'
    case 'OFFSCREEN_DOCUMENT':
      return 'extension-page'
    default:
      return undefined
  }
}

function sameRole(a: ContextRegistration, b: ContextRegistration): boolean {
  return (
    a.kind === b.kind &&
    (a.kind !== 'content-script' ||
      (b.kind === 'content-script' && a.world === b.world))
  )
}

const registrations = new Set<ContextRegistration>()
let cached: { env: Environment; info: ContextInfo } | undefined
let generation = 0
let observedWindow: unknown

function invalidate(): void {
  cached = undefined
  generation++
}

function currentEnvironment(): Environment {
  const env = environment()
  if (
    cached &&
    (cached.env.href !== env.href ||
      cached.env.document !== env.document ||
      cached.env.window !== env.window)
  )
    invalidate()
  return env
}

function registered(info: ContextInfo, env: Environment): ContextInfo {
  const role = registrations.values().next().value
  if (!role) return info
  const compatible =
    info.kind === 'unknown' ||
    (info.kind === 'extension-page' &&
      ['extension-page', 'options'].includes(role.kind)) ||
    (info.kind !== 'popout' && sameRole(info, role))
  if (
    !compatible ||
    parseUrl(env.href)?.searchParams.has(POPOUT_PARAM) ||
    (role.kind === 'content-script'
      ? !env.document || env.own || (env.isolated && role.world !== 'ISOLATED')
      : !env.own || (!env.document && !env.worker))
  ) {
    throw new WebextError(
      'INVALID_ARGUMENT',
      'context.register',
      'Registration contradicts the native context'
    )
  }
  if (role.kind === 'background') {
    return {
      ...info,
      kind: 'background',
      implementation: env.worker ? 'service-worker' : 'page',
      source: 'registered',
    }
  }
  return { ...info, ...role, source: 'registered' }
}

function get(): ContextInfo {
  try {
    const env = currentEnvironment()
    return Object.freeze(registered(cached?.info ?? snapshot(env), env))
  } catch (cause) {
    throw nativeError('context.get', cause)
  }
}

async function resolve(): Promise<ContextInfo> {
  try {
    const env = currentEnvironment()
    if (!env.document && !env.worker)
      throw new WebextError(
        'CONTEXT_UNAVAILABLE',
        'context.resolve',
        'No extension execution context is available'
      )
    // BFCache keeps the realm alive. Drop cached native identity on departure
    // and restoration, and prevent in-flight work from restoring an old result.
    if (env.window && observedWindow !== env.window) {
      const add = property(env.window, 'addEventListener')
      if (typeof add === 'function') {
        add.call(env.window, 'pagehide', invalidate)
        add.call(env.window, 'pageshow', (event: { persisted?: boolean }) => {
          if (event.persisted) invalidate()
        })
      }
      observedWindow = env.window
    }
    const epoch = generation
    let info = snapshot(env)
    if (env.own) {
      const background = info.kind === 'background'
      const tab = background
        ? undefined
        : object(await nativeMethod('tabs', 'getCurrent')?.())
      const window = background
        ? undefined
        : object(await nativeMethod('windows', 'getCurrent')?.())
      const tabId = validId(tab?.id) ? tab.id : undefined
      const windowId = validId(tab?.windowId)
        ? tab.windowId
        : validId(window?.id)
          ? window.id
          : undefined
      const contexts = await nativeMethod('runtime', 'getContexts')?.({})
      if (contexts !== undefined && !Array.isArray(contexts))
        throw new WebextError(
          'NATIVE_ERROR',
          'context.resolve',
          'Invalid getContexts result'
        )
      // A URL alone is never an identity. Restrict by self tab/window and known
      // native role, then require a single candidate.
      const candidates = (Array.isArray(contexts) ? contexts : [])
        .map(object)
        .filter((c): c is Record<string, unknown> => {
          if (!c) return false
          if (env.worker) return c.contextType === 'BACKGROUND'
          // getCurrent identifies a tab, not an embedded frame. Without a
          // native self documentId, an iframe must not borrow its parent's ID.
          if (property(env.window, 'top') !== env.window) return false
          if (
            c.documentUrl !== env.href ||
            windowId === undefined ||
            c.windowId !== windowId
          )
            return false
          if (tabId !== undefined && c.tabId !== tabId) return false
          if (
            tabId !== undefined &&
            property(env.window, 'top') === env.window &&
            c.frameId !== 0
          )
            return false
          return info.kind === 'unknown' || kindOf(c, env) === info.kind
        })
      const self = candidates.length === 1 ? candidates[0] : undefined
      if (self) {
        const kind = kindOf(self, env)
        if (kind === 'background')
          info = {
            kind,
            implementation: env.worker ? 'service-worker' : 'page',
            ...metadata(self),
          }
        else if (kind && kind !== 'popout' && kind !== 'content-script')
          info = { kind, ...metadata(self) }
      }
      // getCurrent describes this page, never the active/associated tab.
      info = {
        ...info,
        ...(tabId !== undefined ? { tabId } : {}),
        ...(windowId !== undefined ? { windowId } : {}),
      }
      const url = parseUrl(env.href)
      if (url?.searchParams.has(POPOUT_PARAM)) {
        const record =
          tabId !== undefined &&
          windowId !== undefined &&
          property(env.window, 'top') === env.window
            ? await readPopoutRecord(url, tabId, windowId)
            : undefined
        info = record
          ? {
              ...info,
              kind: 'popout',
              source: 'verified-record',
              origin: record.source,
              windowId: record.windowId,
              instanceId: record.token,
              ...(record.associatedTabId !== undefined
                ? { associatedTabId: record.associatedTabId }
                : {}),
            }
          : { kind: 'unknown', source: 'unknown' }
      }
    }
    const now = currentEnvironment()
    if (
      epoch !== generation ||
      now.href !== env.href ||
      now.document !== env.document
    ) {
      throw new WebextError(
        'CONTEXT_UNAVAILABLE',
        'context.resolve',
        'Document changed while resolving its context'
      )
    }
    // Validate before caching so a conflicting registration cannot poison get().
    const result = registered(info, env)
    cached = { env, info }
    return Object.freeze(result)
  } catch (cause) {
    throw nativeError('context.resolve', cause)
  }
}

function register(role: ContextRegistration): Unsubscribe {
  const value = object(role)
  const kinds = [
    'background',
    'content-script',
    'popup',
    'side-panel',
    'options',
    'extension-page',
    'devtools',
  ]
  if (
    !value ||
    !kinds.includes(String(value.kind)) ||
    Object.keys(value).some(
      (key) =>
        key !== 'kind' && !(value.kind === 'content-script' && key === 'world')
    ) ||
    (value.kind === 'content-script' &&
      value.world !== 'MAIN' &&
      value.world !== 'ISOLATED')
  ) {
    throw new WebextError(
      'INVALID_ARGUMENT',
      'context.register',
      'Invalid context registration'
    )
  }
  if ([...registrations].some((existing) => !sameRole(existing, role)))
    throw new WebextError(
      'INVALID_ARGUMENT',
      'context.register',
      'A different context is already registered'
    )
  const copy = Object.freeze({ ...role })
  registrations.add(copy)
  try {
    get()
  } catch (cause) {
    registrations.delete(copy)
    throw cause
  }
  return () => {
    registrations.delete(copy)
  }
}

export const webextContext = Object.freeze({ get, resolve, register })
