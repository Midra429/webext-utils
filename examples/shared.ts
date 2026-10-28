export type Messages = {
  'page:title': { data: void; response: string }
  'settings:theme': { data: void; response: 'light' | 'dark' }
}
export type Schema = {
  'settings.theme': 'light' | 'dark'
}
