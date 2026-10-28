import type { Unsubscribe } from '../internal/errors'
import type { PageBridge } from './types'

import { fail } from './protocol'

export interface PageService {
  request(data: unknown, emit: (value: unknown) => void): Promise<unknown>
  reset(): void
}
export const serviceHosts = new WeakMap<PageBridge, Map<string, PageService>>()
export function registerService(
  bridge: PageBridge,
  name: string,
  service: PageService
): Unsubscribe {
  const host = serviceHosts.get(bridge)
  if (!host)
    throw fail('ACCESS_DENIED', 'An active ISOLATED bridge is required')
  if (host.has(name))
    throw fail('INVALID_ARGUMENT', 'Page service already registered')
  host.set(name, service)
  return () => {
    if (host.get(name) === service) {
      service.reset()
      host.delete(name)
    }
  }
}
export interface ServiceClient {
  request(name: string, data: unknown): Promise<unknown>
  listen(name: string, callback: (value: unknown) => void): Unsubscribe
  reconnect(callback: () => void): Unsubscribe
  dispose(): void
}
export const serviceClients = new WeakMap<object, ServiceClient>()
