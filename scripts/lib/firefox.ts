import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// A fresh profile and temporary add-on only. On macOS 27 use LaunchServices:
// direct exec cannot read app data (Mozilla bug 2060476).
export async function launchFirefox(profile: string, addon: string) {
  const freePort = () => {
    const probe = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response(''),
    })
    const port = probe.port!
    probe.stop(true)
    return port
  }
  const port = freePort(),
    marionette = freePort()
  const base = `http://127.0.0.1:${port}`
  const binary =
    process.env.FIREFOX_BINARY ??
    '/Applications/Firefox.app/Contents/MacOS/firefox'
  const mac = process.platform === 'darwin'
  let browser: ReturnType<typeof Bun.spawn> | undefined
  let driver: ReturnType<typeof Bun.spawn> | undefined
  let sessionId: string | undefined
  let pid: number | undefined
  async function request(
    path: string,
    body?: unknown,
    method = body === undefined ? 'GET' : 'POST'
  ): Promise<unknown> {
    const response = await fetch(`${base}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }),
      signal: AbortSignal.timeout(20000),
    })
    const result = (await response.json()) as { value: unknown }
    if (!response.ok) throw Error(JSON.stringify(result.value))
    return result.value
  }
  const close = async () => {
    if (sessionId) {
      try {
        await request(`/session/${sessionId}`, undefined, 'DELETE')
      } catch {}
    }
    if (pid) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {}
    }
    driver?.kill('SIGTERM')
    if (driver) await driver.exited
    browser?.kill('SIGINT')
    if (browser) await browser.exited
  }
  try {
    if (mac) {
      await writeFile(
        join(profile, 'user.js'),
        `user_pref("marionette.port", ${marionette});
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("browser.aboutwelcome.enabled", false);
`
      )
      const app = binary.slice(0, binary.indexOf('.app/') + 4)
      if (!app.endsWith('.app'))
        throw Error('FIREFOX_BINARY must point inside a Firefox.app on macOS')
      browser = Bun.spawn(
        [
          'open',
          '-n',
          '-W',
          app,
          '--args',
          '-no-remote',
          '-profile',
          profile,
          '--marionette',
          '-headless',
        ],
        { stdout: 'inherit', stderr: 'inherit' }
      )
    }
    driver = Bun.spawn(
      [
        process.env.GECKODRIVER_BINARY ?? 'geckodriver',
        '--port',
        String(port),
        ...(mac
          ? ['--connect-existing', '--marionette-port', String(marionette)]
          : []),
      ],
      { stdout: 'inherit', stderr: 'inherit' }
    )
    const deadline = Date.now() + 20000
    while (true) {
      try {
        await request('/status')
        break
      } catch (error) {
        if (Date.now() > deadline) throw error
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    const session = (await request('/session', {
      capabilities: {
        alwaysMatch: {
          browserName: 'firefox',
          ...(mac
            ? {}
            : {
                'moz:firefoxOptions': {
                  binary,
                  args: ['-headless', '-profile', profile],
                },
              }),
        },
      },
    })) as { sessionId: string; capabilities: Record<string, unknown> }
    sessionId = session.sessionId
    pid = session.capabilities['moz:processID'] as number
    await request(`/session/${sessionId}/moz/addon/install`, {
      path: addon,
      temporary: true,
    })
    return { info: session.capabilities, close }
  } catch (error) {
    await close()
    throw error
  }
}
