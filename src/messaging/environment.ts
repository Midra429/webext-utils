import type { ContextInfo } from '../context'
import type { MessageSender } from './types'

import { webextContext } from '../context'
import { nativeError } from '../internal/errors'
import { nativeMethod, nativeValue } from '../internal/native'
import { fail, sender } from './protocol'

// A narrow native boundary, also used by deterministic multi-realm tests.
export class Environment {
  method = nativeMethod
  value = nativeValue
  context: { get(): ContextInfo; resolve(): Promise<ContextInfo> } =
    webextContext
  async call(path: string[], ...args: unknown[]): Promise<unknown> {
    const method = this.method(...path)
    if (!method)
      throw fail(
        path[0] === 'storage' ? 'PERMISSION_DENIED' : 'CONTEXT_UNAVAILABLE',
        `Missing ${path.join('.')}`
      )
    try {
      return await method(...args)
    } catch (error) {
      throw nativeError(path.join('.'), error)
    }
  }
  listen(
    path: string[],
    listener: (...args: unknown[]) => unknown
  ): () => void {
    const add = this.method(...path, 'addListener')
    const remove = this.method(...path, 'removeListener')
    if (!add || !remove)
      throw fail('CONTEXT_UNAVAILABLE', `Missing ${path.join('.')}`)
    add(listener)
    return () => {
      remove(listener)
    }
  }
  sender(value: unknown): MessageSender {
    const from = sender(value, this.value('runtime', 'id'))
    const root = this.method('runtime', 'getURL')?.('')
    return typeof root === 'string' && from.url?.startsWith(root)
      ? { ...from, context: 'extension-page' }
      : from
  }
  ownSender(): MessageSender {
    return {
      id: String(this.value('runtime', 'id')),
      context: 'background',
      trust: 'extension',
    }
  }
}
