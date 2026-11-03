import type { MessageHub } from '../hub'
import type { MessageTarget, PageBridge } from '../types'

import { DEFAULT_TIMEOUT, deadline, fail, name, target } from '../protocol'
import { PagePeer } from './peer'
import { serviceHosts } from './services'
import { PageEnvironment, channel } from './wire'

type Rule = {
  target?: MessageTarget
  validateData(value: unknown): boolean
  validateResponse(value: unknown): boolean
}
export type RuntimePolicy = {
  channel: string
  allowedOrigins: readonly string[]
  fromPage: Record<string, Rule>
  toPage: Record<string, Rule>
}
const installations = new WeakMap<object, Set<string>>()
/**
 * Work started by a page reaches the shared Background. Each document's work
 * runs one at a time (across all of its channels), so a page that floods the
 * bridge only queues work in its own process instead of loading the
 * Background with concurrent requests.
 */
const queues = new WeakMap<object, Promise<unknown>>()
function serialize<T>(document: object, work: () => Promise<T>): Promise<T> {
  const task = (queues.get(document) ?? Promise.resolve())
    .catch(() => {})
    .then(work)
  queues.set(document, task)
  return task
}
function origin(value: string): string {
  const url = new URL(value)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.origin === 'null' ||
    url.username ||
    url.password
  )
    throw fail('ACCESS_DENIED', 'Page origin must be HTTP(S)')
  return url.origin
}
export function validate(
  rule: Rule,
  kind: 'validateData' | 'validateResponse',
  value: unknown
): void {
  try {
    if (rule[kind](value) === true) return
  } catch {
    /* A validator failure never crosses into the page. */
  }
  throw fail('VALIDATION_ERROR', 'Page policy validation failed')
}
function sameTarget(a: unknown, b: MessageTarget): boolean {
  const normalize = (v: unknown) => {
    const t = target(v)
    return t.context === 'content-script'
      ? { ...t, world: t.world ?? 'ISOLATED', frameId: t.frameId ?? 0 }
      : t
  }
  const x = normalize(a),
    y = normalize(b)
  return (
    Object.keys(x).length === Object.keys(y).length &&
    Object.entries(x).every(
      ([k, v]) => v === (y as unknown as Record<string, unknown>)[k]
    )
  )
}

export class IsolatedBridge extends PagePeer implements PageBridge {
  private proxy: MessageHub
  private owner = {}
  private subscriptions: (() => void)[] = []
  /** IDs of requests in progress; a reused ID would mix up replies. */
  private activeIds = new Set<string>()
  private registeredNames: string[] = []
  private policy: RuntimePolicy
  constructor(
    private hub: MessageHub,
    options: RuntimePolicy,
    page = new PageEnvironment(),
    private removed = () => {}
  ) {
    super(options.channel, page, true)
    channel(options.channel)
    this.proxy = hub.pageHub()
    // Copy policy maps/targets: subsequent caller mutation cannot widen authority.
    const copy = (rules: Record<string, Rule>, outbound: boolean) => {
      const result = Object.create(null) as Record<string, Rule>
      for (const [key, rule] of Object.entries(rules)) {
        name(key)
        if (
          !rule ||
          typeof rule.validateData !== 'function' ||
          typeof rule.validateResponse !== 'function'
        )
          throw fail('INVALID_ARGUMENT', 'Both page validators are required')
        result[key] = {
          validateData: rule.validateData,
          validateResponse: rule.validateResponse,
          ...(outbound ? { target: { ...target(rule.target) } } : {}),
        }
      }
      return result
    }
    this.policy = {
      ...options,
      fromPage: copy(options.fromPage, true),
      toPage: copy(options.toPage, false),
      allowedOrigins: options.allowedOrigins.map(origin),
    }
    this.checkOrigin()
    const installed = installations.get(page.document) ?? new Set<string>()
    if (installed.has(this.channel))
      throw fail('INVALID_ARGUMENT', 'Page channel already installed')
    installed.add(this.channel)
    installations.set(page.document, installed)
    serviceHosts.set(this, new Map())
    this.attach()
  }
  private checkOrigin(): void {
    // globalThis.origin reflects sandbox opacity; location.origin alone does not.
    const actual = this.page.origin()
    if (
      actual === 'null' ||
      origin(actual) !== origin(this.page.href()) ||
      !this.policy.allowedOrigins.includes(origin(actual))
    )
      throw fail('ACCESS_DENIED', 'Page origin is not allowed')
  }
  private admit(id: string): void {
    this.checkOrigin()
    if (this.activeIds.has(id))
      throw fail('VALIDATION_ERROR', 'Duplicate page request ID')
    this.activeIds.add(id)
  }
  /** Time left of a page request that may have waited in the queue. */
  private remaining(received: number, timeout: number): number {
    const left = timeout - (Date.now() - received)
    if (left <= 0) throw fail('TIMEOUT', 'Page request expired in the queue')
    return left
  }
  protected async handle(v: Record<string, unknown>): Promise<void> {
    const id = String(v.id)
    const epoch = this.epoch
    const received = Date.now()
    const current = () =>
      epoch === this.epoch && !this.stopped && !this.suspended
    let admitted = false
    try {
      this.admit(id)
      admitted = true
      if (v.type === 'hello') {
        if (
          !Array.isArray(v.names) ||
          v.names.length > 1024 ||
          !v.names.every(
            (n) => typeof n === 'string' && Object.hasOwn(this.policy.toPage, n)
          ) ||
          new Set(v.names).size !== v.names.length
        )
          throw fail('ACCESS_DENIED', 'Page handler is not allowed')
        const names = v.names as string[]
        const task = async () => {
          if (epoch !== this.epoch || this.stopped || this.suspended) return
          if (this.session && this.session !== v.session) this.reset()
          const changedSession = this.session !== v.session
          this.session = String(v.session)
          if (changedSession) {
            for (const service of serviceHosts.get(this)?.values() ?? [])
              service.reset()
            this.clearSubscriptions()
          }
          const changed =
            names.length !== this.registeredNames.length ||
            names.some((key) => !this.registeredNames.includes(key))
          if (changed) this.clearSubscriptions()
          for (const key of changed ? names : []) {
            const rule = this.policy.toPage[key]!
            this.subscriptions.push(
              this.proxy.on(this.owner, key, async (data, sender, request) => {
                this.checkOrigin()
                validate(rule, 'validateData', data)
                const value = this.result(
                  await this.exchange(
                    'request',
                    {
                      name: key,
                      mode: 'send',
                      timeoutMs: Math.max(1, request.deadline - Date.now()),
                      ...(data === undefined ? {} : { data }),
                      sender,
                    },
                    Math.max(1, request.deadline - Date.now())
                  )
                )
                this.checkOrigin()
                validate(rule, 'validateResponse', value)
                return value
              })
            )
          }
          this.registeredNames = [...names]
          await this.proxy.ready()
          if (this.stopped || this.suspended || this.session !== v.session)
            return
          this.respond(id, undefined)
        }
        await serialize(this.page.document, task)
        return
      }
      if (v.session !== this.session) return
      if (v.type === 'service') {
        const service = serviceHosts.get(this)?.get(String(v.name))
        if (!service) throw fail('ACCESS_DENIED', 'Page service is not exposed')
        const value = await serialize(this.page.document, async () => {
          if (!current())
            throw fail('TRANSPORT_CLOSED', 'Page bridge disconnected')
          return await deadline(
            service.request(v.data, (data) => {
              this.checkOrigin()
              if (current())
                this.emit('service-event', crypto.randomUUID(), {
                  name: v.name,
                  data,
                })
            }),
            Date.now() + this.remaining(received, DEFAULT_TIMEOUT),
            this.cancellations
          )
        })
        this.checkOrigin()
        if (epoch === this.epoch && !this.stopped && !this.suspended)
          this.respond(id, value)
        return
      }
      if (v.type === 'close') {
        this.suspend()
        this.reset()
        this.session = ''
        return
      }
      if (v.type !== 'request')
        throw fail('ACCESS_DENIED', 'Invalid page operation')
      {
        name(v.name)
        if (
          v.sender !== undefined ||
          !['send', 'notify'].includes(String(v.mode)) ||
          !Object.hasOwn(this.policy.fromPage, v.name)
        )
          throw fail('ACCESS_DENIED', 'Page operation is not allowed')
        const rule = this.policy.fromPage[v.name]!
        if (v.target !== undefined && !sameTarget(v.target, rule.target!))
          throw fail('ACCESS_DENIED', 'Page target is fixed by policy')
        validate(rule, 'validateData', v.data)
        const timeout = v.timeoutMs ?? DEFAULT_TIMEOUT
        if (
          typeof timeout !== 'number' ||
          !Number.isFinite(timeout) ||
          timeout <= 0 ||
          timeout > 2147483647
        )
          throw fail('INVALID_ARGUMENT', 'Invalid page timeout')
        const messageName = v.name
        const value = await serialize(this.page.document, async () => {
          if (!current())
            throw fail('TRANSPORT_CLOSED', 'Page bridge disconnected')
          const left = this.remaining(received, timeout)
          return await deadline(
            this.hub.send(
              messageName,
              v.data,
              { target: rule.target!, timeoutMs: left },
              v.mode as 'send' | 'notify',
              this.cancellations,
              true
            ),
            Date.now() + left,
            this.cancellations
          )
        })
        validate(rule, 'validateResponse', value)
        if (epoch === this.epoch && !this.stopped && !this.suspended)
          this.respond(id, value)
      }
    } catch (error) {
      if (epoch === this.epoch && !this.stopped && !this.suspended) {
        // For initial handshakes, echo only the correlation session, never sender input.
        const previous = this.session
        if (v.type === 'hello') this.session = String(v.session)
        try {
          this.reject(id, error)
        } finally {
          this.session = previous
        }
      }
    } finally {
      if (admitted) this.activeIds.delete(id)
    }
  }
  private clearSubscriptions(): void {
    for (const stop of this.subscriptions) stop()
    this.subscriptions = []
    this.registeredNames = []
  }
  protected suspend(): void {
    for (const service of serviceHosts.get(this)?.values() ?? [])
      service.reset()
    this.clearSubscriptions()
    this.proxy.dispose(this.owner)
  }
  protected resume(): void {
    this.session = ''
  }
  override dispose(): void {
    if (this.stopped) return
    try {
      if (this.session && !this.suspended)
        this.emit('close', crypto.randomUUID())
    } catch {
      /* Page teardown. */
    }
    super.dispose()
    serviceHosts.delete(this)
    installations.get(this.page.document)?.delete(this.channel)
    this.removed()
  }
}
