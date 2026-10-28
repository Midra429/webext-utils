import type { WebextError } from '../internal/errors'
import type { Limits, PageEnvironment } from './page-wire'

import { nativeError } from '../internal/errors'
import { object } from '../internal/native'
import { PAGE_PROTOCOL, decode, encode, eventName } from './page-wire'
import { DEFAULT_TIMEOUT, deadline, fail, reply, wire } from './protocol'

export abstract class PagePeer {
  protected pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: unknown): void }
  >()
  protected cancellations = new Set<(error: WebextError) => void>()
  protected session = ''
  protected epoch = 0
  protected stopped = false
  protected suspended = false
  protected listening = false
  constructor(
    protected channel: string,
    protected page: PageEnvironment,
    protected bound: Limits,
    protected isolated: boolean
  ) {}
  protected attach(): void {
    if (this.listening || this.stopped) return
    this.listening = true
    this.page.document.addEventListener(
      eventName(this.channel, this.isolated),
      this.receive
    )
    this.page.window.addEventListener('pagehide', this.hide)
    this.page.window.addEventListener('pageshow', this.show)
  }
  private receive = (event: Event): void => {
    try {
      if (event.target !== this.page.document || this.suspended) return
      const v = decode((event as CustomEvent<unknown>).detail, this.bound)
      if (v.direction !== (this.isolated ? 'from-page' : 'to-page')) return
      if (v.type === 'reply') {
        if (v.session !== this.session) return
        this.pending.get(String(v.id))?.resolve(v)
        return
      }
      void this.handle(v).catch(() => {})
    } catch {
      /* Uncorrelated malformed input is dropped without a response. */
    }
  }
  protected emit(
    type: string,
    id: string,
    extra: Record<string, unknown> = {}
  ): void {
    if (this.stopped || this.suspended)
      throw fail('TRANSPORT_CLOSED', 'Page bridge closed')
    this.page.emit(
      eventName(this.channel, !this.isolated),
      encode(
        {
          protocol: PAGE_PROTOCOL,
          version: 1,
          direction: this.isolated ? 'to-page' : 'from-page',
          type,
          id,
          session: this.session,
          ...extra,
        },
        this.bound
      )
    )
  }
  protected load(): number {
    return this.pending.size
  }
  protected async exchange(
    type: string,
    extra: Record<string, unknown>,
    timeoutMs = DEFAULT_TIMEOUT,
    cancellations = new Set<(error: WebextError) => void>()
  ): Promise<unknown> {
    if (this.load() >= this.bound.maxPending)
      throw fail('QUOTA_EXCEEDED', 'Too many pending page requests')
    const id = crypto.randomUUID()
    try {
      return await deadline(
        new Promise<unknown>((resolve, reject) => {
          this.pending.set(id, { resolve, reject })
          try {
            this.emit(type, id, extra)
          } catch (error) {
            reject(error)
          }
        }),
        Date.now() + timeoutMs,
        this.cancellations,
        cancellations
      )
    } finally {
      this.pending.delete(id)
    }
  }
  protected result(value: unknown): unknown {
    const v = object(value)!
    if (
      typeof v.ok !== 'boolean' ||
      (v.ok && v.error !== undefined) ||
      (!v.ok && v.value !== undefined)
    )
      throw fail('VALIDATION_ERROR', 'Invalid page reply')
    return reply(
      {
        ...wire('reply'),
        id: v.id,
        ok: v.ok,
        ...(v.ok
          ? v.value === undefined
            ? {}
            : { value: v.value }
          : { error: v.error }),
      },
      String(v.id)
    )
  }
  protected respond(id: string, value: unknown): void {
    this.emit('reply', id, {
      ok: true,
      ...(value === undefined ? {} : { value }),
    })
  }
  protected reject(id: string, error: unknown): void {
    const e = nativeError('page bridge', error)
    this.emit('reply', id, {
      ok: false,
      error: {
        code: e.code,
        message: `Page bridge request failed (${e.code})`,
      },
    })
  }
  protected reset(): void {
    this.epoch++
    for (const cancel of this.cancellations)
      cancel(fail('TRANSPORT_CLOSED', 'Page bridge disconnected'))
    this.cancellations.clear()
    this.pending.clear()
  }
  private hide = (event: Event): void => {
    if (!(event as PageTransitionEvent).persisted) {
      this.dispose()
      return
    }
    this.suspend()
    this.suspended = true
    this.reset()
    this.page.document.removeEventListener(
      eventName(this.channel, this.isolated),
      this.receive
    )
  }
  private show = (event: Event): void => {
    if (
      !(event as PageTransitionEvent).persisted ||
      !this.suspended ||
      this.stopped
    )
      return
    this.suspended = false
    this.page.document.addEventListener(
      eventName(this.channel, this.isolated),
      this.receive
    )
    this.resume()
  }
  protected abstract handle(v: Record<string, unknown>): Promise<void>
  protected abstract suspend(): void
  protected abstract resume(): void
  dispose(): void {
    if (this.stopped) return
    this.suspend()
    this.stopped = true
    this.reset()
    this.page.document.removeEventListener(
      eventName(this.channel, this.isolated),
      this.receive
    )
    this.page.window.removeEventListener('pagehide', this.hide)
    this.page.window.removeEventListener('pageshow', this.show)
    this.listening = false
  }
}
