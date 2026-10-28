import type { Realm } from './realm'
import type { MessageTarget, PageBridge, PageBridgeOptions } from './types'

import { PagePeer } from './page-peer'
import { serviceHosts } from './page-services'
import { PageEnvironment, channel, limits } from './page-wire'
import { DEFAULT_TIMEOUT, deadline, fail, name, target } from './protocol'

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
  limits?: PageBridgeOptions['limits']
}
const installations = new WeakMap<object, Set<string>>()
const traffic = new WeakMap<object, number[]>()
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
  private proxy: Realm
  private owner = {}
  private subscriptions: (() => void)[] = []
  private seen = new Set<string>()
  private registeredNames: string[] = []
  private active = 0
  private updates: Promise<void> = Promise.resolve()
  private policy: RuntimePolicy
  constructor(
    private realm: Realm,
    options: RuntimePolicy,
    page = new PageEnvironment(),
    private removed = () => {}
  ) {
    super(options.channel, page, limits(options.limits), true)
    channel(options.channel)
    this.proxy = realm.pageRealm()
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
  protected override load(): number {
    return this.pending.size + this.active
  }
  private admit(id: string): void {
    this.checkOrigin()
    const now = Date.now()
    const recent = (traffic.get(this.page.document) ?? []).filter(
      (t) => now - t < 60000
    )
    if (
      recent.length >= this.bound.requestsPerMinute ||
      this.load() >= this.bound.maxPending ||
      this.seen.has(id) ||
      this.seen.size >= 65536
    )
      throw fail('QUOTA_EXCEEDED', 'Page request limit exceeded')
    recent.push(now)
    traffic.set(this.page.document, recent)
    this.seen.add(id)
  }
  protected async handle(v: Record<string, unknown>): Promise<void> {
    const id = String(v.id)
    const epoch = this.epoch
    let admitted = false
    try {
      this.admit(id)
      this.active++
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
            this.seen.clear()
            this.seen.add(id)
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
        const updated = this.updates.catch(() => {}).then(task)
        this.updates = updated
        await updated
        return
      }
      if (v.session !== this.session) return
      if (v.type === 'service') {
        const service = serviceHosts.get(this)?.get(String(v.name))
        if (!service) throw fail('ACCESS_DENIED', 'Page service is not exposed')
        const value = await deadline(
          service.request(v.data, (data) => {
            this.checkOrigin()
            if (epoch === this.epoch && !this.stopped && !this.suspended)
              this.emit('service-event', crypto.randomUUID(), {
                name: v.name,
                data,
              })
          }),
          Date.now() + DEFAULT_TIMEOUT,
          this.cancellations
        )
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
        const value = await deadline(
          this.realm.send(
            v.name,
            v.data,
            { target: rule.target!, timeoutMs: timeout },
            v.mode as 'send' | 'notify',
            this.cancellations,
            true
          ),
          Date.now() + timeout,
          this.cancellations
        )
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
      if (admitted) this.active--
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
    this.seen.clear()
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
