import { nativeMethod } from '../../src/internal/browser'
import { webextSidePanel } from '../../src/side-panel'

// Publishes onOpened / onClosed to the test page in every browser.
webextSidePanel.startBackground()
void nativeMethod(
  'tabs',
  'create'
)?.({
  url: String(nativeMethod('runtime', 'getURL')?.('test.html')),
})
