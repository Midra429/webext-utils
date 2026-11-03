import { webextSidePanel } from '../../src/side-panel'

// The panel page announces itself so onOpened / onClosed work in every browser.
webextSidePanel.registerPanel()
