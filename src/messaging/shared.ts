import { Realm } from './realm'

let realm: Realm | undefined
export function currentRealm(): Realm {
  return (realm ??= new Realm())
}
