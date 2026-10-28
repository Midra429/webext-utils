import { webextMessaging } from '@midra/webext-utils/messaging'

const empty = webextMessaging()
// @ts-expect-error no global declaration means no known names
empty.send('arbitrary')
// @ts-expect-error no global declaration means no known handlers
empty.on('arbitrary', () => {})
const explicit = webextMessaging<{ only: { data: void; response: number } }>()
const result: number = await explicit.send('only')
// @ts-expect-error only explicit keys are allowed
explicit.send('other')
void result
