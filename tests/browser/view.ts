import { webextContext } from '../../src/context'
import { POPOUT_PARAM } from '../../src/internal/popout-record'
import { bridgeView } from './bridge'
import { viewMessaging } from './messaging'
import { report } from './report'
import { storageView } from './storage'

const url = new URL(location.href)
if (url.searchParams.has(POPOUT_PARAM)) {
  void report('popout-before-verify', () => webextContext.get(), 'unknown')
  void report('popout', () => webextContext.resolve(), 'popout')
} else if (url.pathname.endsWith('/options.html')) {
  webextContext.register({ kind: 'options' })
  void report('options', () => webextContext.resolve(), 'options')
} else {
  void bridgeView()
  void storageView()
  void (async () => {
    await report(
      'extension-tab',
      () => webextContext.resolve(),
      'extension-page'
    )
    await viewMessaging()
  })()
}
