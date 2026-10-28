import type { ContextInfo } from '../../src/context'

declare const TEST_ORIGIN: string

export const testOrigin = TEST_ORIGIN

export async function report(
  name: string,
  run: () => Promise<ContextInfo> | ContextInfo,
  expected: ContextInfo['kind']
): Promise<void> {
  try {
    const info = await run()
    await fetch(`${TEST_ORIGIN}/report`, {
      method: 'POST',
      body: JSON.stringify({ name, passed: info.kind === expected, info }),
    })
  } catch (error) {
    await fetch(`${TEST_ORIGIN}/report`, {
      method: 'POST',
      body: JSON.stringify({ name, passed: false, error: String(error) }),
    })
  }
}
