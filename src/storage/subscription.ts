import type { Unsubscribe } from '../internal/errors'
import type { StorageSubscription, StorageWatchOptions } from './types'

import { WebextError, nativeError } from '../internal/errors'
import { fail } from './common'

/** Callable for compatibility, with an observable registration boundary. */
export function subscription(
  cleanup: Unsubscribe,
  registration: Promise<void>,
  options: StorageWatchOptions = {}
): StorageSubscription {
  let active = true
  let cancel!: (error: WebextError) => void
  let settled = false
  const cancelled = new Promise<never>((_, reject) => {
    cancel = reject
  })
  const stop = () => {
    if (!active) return
    active = false
    if (!settled)
      cancel(
        fail('TRANSPORT_CLOSED', 'Storage subscription removed before ready')
      )
    cleanup()
  }
  const ready = Promise.race([registration, cancelled])
  void (async () => {
    try {
      await ready
      settled = true
    } catch (cause) {
      settled = true
      const report = active
      stop()
      if (report) {
        try {
          options.onError?.(
            cause instanceof WebextError
              ? cause
              : nativeError('storage.watch', cause)
          )
        } catch {
          /* An error observer cannot retain subscription resources. */
        }
      }
    }
  })()
  return Object.assign(stop, { ready })
}
