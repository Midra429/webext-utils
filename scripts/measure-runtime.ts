import { writeFile } from 'node:fs/promises'

import { Realm } from '../src/messaging/realm'
import { NativeBus } from '../tests/helpers/messaging-native'

// Deterministic native-boundary measurement, not a browser benchmark.
const bus = new NativeBus()
const background = new Realm(bus.realm('background').env)
const view = bus.realm('extension-page')
const receiver = new Realm(view.env)
const sender = new Realm(bus.realm('extension-page').env)
const owner = {}
const pending: Parameters<Realm['send']>[4] = new Set()
const snapshot = () => ({
  ports: bus.activePorts(),
  listeners: bus.realms.reduce(
    (sum, realm) =>
      sum + realm.onMessage.listeners.size + realm.onConnect.listeners.size,
    0
  ),
  records: Object.keys(bus.records).length,
  pending: pending.size,
})
const initial = snapshot()
const stop = background.startBackground()
try {
  receiver.on(owner, 'measure:echo', async (value) => {
    await Promise.resolve()
    return value
  })
  await receiver.ready()
  const registered = snapshot()
  const responses = await Promise.all(
    Array.from({ length: 100 }, (_, i) =>
      sender.send(
        'measure:echo',
        i,
        { target: { context: 'extension-page' } },
        'send',
        pending
      )
    )
  )
  if (!responses.every((v, i) => v === i))
    throw Error('Response correlation failed')
  const settled = snapshot()
  const connects = bus.connects
  await new Promise((resolve) => setTimeout(resolve, 50))
  if (bus.connects !== connects) throw Error('Idle connection churn')
  receiver.dispose(owner)
  await receiver.ready()
  stop()
  const disposed = snapshot()
  if (
    Object.values(initial).some(Boolean) ||
    settled.pending ||
    Object.values(disposed).some(Boolean)
  )
    throw Error('Resource cleanup failed')
  const report = {
    environment: 'Bun / fake native boundary',
    initial,
    registered,
    concurrentRequests: 100,
    settled,
    idleConnectionsAdded: bus.connects - connects,
    disposed,
  }
  console.log(JSON.stringify(report, null, 2))
  if (process.env.RUNTIME_REPORT)
    await writeFile(
      process.env.RUNTIME_REPORT,
      JSON.stringify(report, null, 2) + '\n'
    )
} finally {
  receiver.dispose(owner)
  stop()
}
