import type { PageBridge } from '@midra/webext-utils/messaging'

import { webextStorage } from '@midra/webext-utils/storage'

type Schema = {
  'settings.theme': 'light' | 'dark'
  'settings.language': string
  'settings.notifications': boolean
  'settings.editor.fontSize': number
  'settingsExtra.theme': string
  'cache.lastTitle': string
}
const storage = webextStorage<Schema>()
const theme: 'light' | 'dark' | undefined = await storage.get('settings.theme')
// @ts-expect-error missing value must be considered
const unsafe: 'light' | 'dark' = await storage.get('settings.theme')
// @ts-expect-error unknown key
storage.get('missing')
// @ts-expect-error value must match the key
storage.set('settings.notifications', 'yes')
// @ts-expect-error undefined writes are forbidden
storage.set('settings.theme', undefined)
const pair = await storage.getMany([
  'settings.theme',
  'settings.notifications',
] as const)
const t: 'light' | 'dark' | undefined = pair['settings.theme']
const n: boolean | undefined = pair['settings.notifications']
// @ts-expect-error keys preserve distinct value types
const wrong: boolean | undefined = pair['settings.theme']
await storage.setMany({
  'settings.theme': 'dark',
  'settings.notifications': false,
})
// @ts-expect-error batch values preserve distinct types
storage.setMany({ 'settings.theme': true })
// @ts-expect-error excess batch keys
storage.setMany({ 'settings.theme': 'dark', extra: 1 })
const excess = { 'settings.theme': 'dark' as const, extra: 1 }
// @ts-expect-error excess keys through a variable
storage.setMany(excess)
// @ts-expect-error batch cannot write undefined
storage.setMany({ 'settings.theme': undefined })
const settings = storage.namespace('settings')
await settings.namespace('editor').set('fontSize', 16)
await storage.namespace('settings.editor').set('fontSize', 18)
// @ts-expect-error namespace only matches a dot boundary
settings.get('Extra.theme')
// @ts-expect-error namespace cannot escape
settings.get('cache.lastTitle')
// @ts-expect-error full keys are stripped
settings.set('settings.theme', 'dark')
// @ts-expect-error unknown namespace
storage.namespace('missing')
// @ts-expect-error leaf is not a namespace
storage.namespace('settings.theme')
settings.watch('theme', (c) => {
  const old: 'light' | 'dark' | undefined = c.oldValue
  const next: 'light' | 'dark' | undefined = c.newValue
  void [old, next]
})
// @ts-expect-error observer parameter cannot assume a number
settings.watch('theme', (c: { newValue: number }) => {
  void c
})
settings.watchAll(['notifications', 'editor.fontSize'], (c) => {
  if (c.key === 'notifications') {
    const value: boolean | undefined = c.newValue
    void value
  } else if (c.key === 'editor.fontSize') {
    const value: number | undefined = c.oldValue
    void value
  }
})
await settings.migrate({
  version: 1,
  steps: {
    1: (draft) => {
      const previous: unknown = draft.get('oldKey')
      // @ts-expect-error old storage has no current schema type
      const current: string = draft.get('theme')
      draft.remove('oldKey')
      draft.set('theme', 'light')
      // @ts-expect-error JSON only
      draft.set('bad', undefined)
      void [previous, current]
    },
  },
})
webextStorage<Schema>({
  validate: {
    'settings.theme': (value) => {
      if (value !== 'dark' && value !== 'light') throw Error('Invalid theme')
      return value
    },
  },
})
// @ts-expect-error parser must return the corresponding value
webextStorage<Schema>({ validate: { 'settings.theme': () => 42 } })
// @ts-expect-error schemas must be JSON
webextStorage<{ callback: () => void }>()
// @ts-expect-error invalid area
webextStorage<Schema>({ area: 'managed' })
declare const bridge: PageBridge
settings.exposeToPage(bridge, {
  read: ['theme'],
  write: ['theme'],
  watch: ['theme'],
  validate: {
    theme: (v): v is 'dark' | 'light' => v === 'dark' || v === 'light',
  },
})
// @ts-expect-error namespace exposure keys must be relative
settings.exposeToPage(bridge, { read: ['settings.theme'], validate: {} })
settings.exposeToPage(bridge, {
  read: ['theme'],
  // @ts-expect-error validator output type must match the schema
  validate: { theme: (v): v is number => typeof v === 'number' },
})
void [theme, unsafe, t, n, wrong]

const subscription = settings.watchAll(
  ['theme', 'notifications'],
  (change) => {
    if (change.key === 'theme') {
      const value: 'light' | 'dark' | undefined = change.newValue
      void value
    } else {
      const value: boolean | undefined = change.oldValue
      void value
    }
  },
  {
    onError: (error) => {
      const code: string = error.code
      void code
    },
  }
)
const ready: Promise<void> = subscription.ready
subscription()
settings.watchAll((change) => {
  const key: string = change.key
  const value: unknown = change.newValue
  // @ts-expect-error unselected namespace keys cannot be narrowed from the schema
  const unsafeKey: 'theme' = change.key
  // @ts-expect-error unknown keys may carry other value types
  const unsafeValue: string | undefined = change.newValue
  void [key, value, unsafeKey, unsafeValue]
})
// @ts-expect-error selected keys must belong to this namespace
settings.watchAll(['missing'], () => {})
void ready
