import { object } from '../internal/native'
import { fail } from './protocol'

export interface Port {
  name: string
  sender?: unknown
  postMessage(message: unknown): void
  disconnect(): void
  onMessage: {
    addListener(cb: (value: unknown) => void): void
    removeListener(cb: (value: unknown) => void): void
  }
  onDisconnect: {
    addListener(cb: () => void): void
    removeListener(cb: () => void): void
  }
}
export function port(value: unknown): Port {
  const p = object(value)
  if (
    typeof p?.name !== 'string' ||
    typeof p.postMessage !== 'function' ||
    typeof p.disconnect !== 'function' ||
    typeof object(p.onMessage)?.addListener !== 'function' ||
    typeof object(p.onDisconnect)?.addListener !== 'function'
  )
    throw fail('VALIDATION_ERROR', 'Invalid native Port')
  return p as unknown as Port
}
export function observe(
  p: Port,
  message: (v: unknown) => void,
  disconnect: () => void
): () => void {
  p.onMessage.addListener(message)
  p.onDisconnect.addListener(disconnect)
  return () => {
    p.onMessage.removeListener(message)
    p.onDisconnect.removeListener(disconnect)
  }
}
