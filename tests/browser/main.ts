import { webextContext } from '../../src/context'
import { bridgeMain } from './bridge'
import { report } from './report'
import { storageMain } from './storage'

void (async () => {
  await report('main-before-registration', () => webextContext.get(), 'unknown')
  const stop = webextContext.register({ kind: 'content-script', world: 'MAIN' })
  await report('main', () => webextContext.resolve(), 'content-script')
  stop()
})()

void bridgeMain()

void storageMain()
