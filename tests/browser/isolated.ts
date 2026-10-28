import { webextContext } from '../../src/context'
import { bridgeIsolated } from './bridge'
import { contentMessaging } from './messaging'
import { report } from './report'
import { storageIsolated } from './storage'

void report('isolated', () => webextContext.resolve(), 'content-script')

void contentMessaging()

void bridgeIsolated()

void storageIsolated()
