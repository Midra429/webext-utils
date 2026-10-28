import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// Only isolated profiles and the extension fixture created here are controlled.
const root = resolve(import.meta.dir, '..')
const firefox = process.argv.includes('--firefox')
const manual = process.argv.includes('--manual')
const PORT_NUMBER = /^\d+$/
const temp = await mkdtemp('/private/tmp/webext-popout-')
const profile = await mkdtemp('/private/tmp/webext-popout-profile-')
const results: { name: string; passed: boolean; error?: string }[] = []
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname === '/target')
      return new Response(
        '<!doctype html><title>Associated tab fixture</title>',
        { headers: { 'Content-Type': 'text/html' } }
      )
    if (new URL(request.url).pathname === '/ready') {
      await request.text()
      return new Response('ok')
    }
    if (new URL(request.url).pathname !== '/report')
      return new Response('Not found', { status: 404 })
    const report = (await request.json()) as (typeof results)[number]
    results.push(report)
    console.log(JSON.stringify(report))
    return new Response('ok', {
      headers: { 'Access-Control-Allow-Origin': '*' },
    })
  },
})
let browser: ReturnType<typeof Bun.spawn> | undefined
let driver: ReturnType<typeof Bun.spawn> | undefined
let sessionId: string | undefined
let webdriverUrl = ''
let firefoxPid: number | undefined
let browserInfo: unknown
let lifecycle: unknown
let socket: WebSocket | undefined
async function webdriver(
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST'
): Promise<unknown> {
  const response = await fetch(`${webdriverUrl}${path}`, {
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
  if (!response.ok) throw new Error(JSON.stringify(result.value))
  return result.value
}
function freePort(): number {
  const probe = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response(''),
  })
  const port = probe.port!
  probe.stop(true)
  return port
}
const deadline = Date.now() + (manual ? 300000 : 60000)
async function poll<T>(read: () => Promise<T | undefined>): Promise<T> {
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Popout test timeout (${results.length}/12 reports)`)
}
try {
  const build = await Bun.build({
    entrypoints: [
      join(root, 'tests/browser/popout-background.ts'),
      join(root, 'tests/browser/popout-view.ts'),
      join(root, 'tests/browser/popout-content.ts'),
    ],
    outdir: temp,
    target: 'browser',
    format: 'iife',
    define: { TEST_ORIGIN: JSON.stringify(`http://127.0.0.1:${server.port}`) },
  })
  if (!build.success) throw new Error(String(build.logs))
  for (const name of ['ui.html', 'panel.html', 'other.html'])
    await writeFile(
      join(temp, name),
      '<!doctype html><title>Popout fixture</title><script src="popout-view.js" defer></script>'
    )
  await writeFile(
    join(temp, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'webext-utils popout test',
      version: '0.0.1',
      permissions: firefox
        ? ['storage', 'tabs']
        : ['storage', 'tabs', 'sidePanel'],
      host_permissions: ['http://127.0.0.1/*'],
      action: { default_popup: 'ui.html' },
      content_scripts: [
        {
          matches: ['http://127.0.0.1/*'],
          js: ['popout-content.js'],
          run_at: 'document_idle',
        },
      ],
      ...(firefox
        ? {
            browser_specific_settings: {
              gecko: {
                id: 'webext-popout@example.com',
                strict_min_version: '145.0',
              },
            },
            background: { scripts: ['popout-background.js'] },
            sidebar_action: {
              default_panel: 'panel.html',
              default_title: 'Fixture',
              open_at_install: false,
            },
          }
        : {
            minimum_chrome_version: '142',
            background: { service_worker: 'popout-background.js' },
            side_panel: { default_path: 'panel.html' },
          }),
    })
  )
  if (firefox) {
    const port = freePort()
    webdriverUrl = `http://127.0.0.1:${port}`
    const binary =
      process.env.FIREFOX_BINARY ??
      '/Applications/Firefox.app/Contents/MacOS/firefox'
    const mac = process.platform === 'darwin'
    const marionettePort = freePort()
    if (mac) {
      // macOS 27 blocks direct exec from reading Firefox app data (Mozilla 2060476).
      // LaunchServices works without granting Terminal access to real profile data.
      await writeFile(
        join(profile, 'user.js'),
        `user_pref("marionette.port", ${marionettePort});
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("browser.aboutwelcome.enabled", false);
`
      )
      const app = binary.slice(0, binary.indexOf('.app/') + 4)
      if (!app.endsWith('.app'))
        throw new Error(
          'FIREFOX_BINARY must point inside a Firefox.app on macOS'
        )
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
          ...(manual ? [] : ['-headless']),
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
          ? ['--connect-existing', '--marionette-port', String(marionettePort)]
          : []),
      ],
      { stdout: 'inherit', stderr: 'inherit' }
    )
    await poll(async () => {
      try {
        await webdriver('/status')
        return true
      } catch {
        return undefined
      }
    })
    const session = (await webdriver('/session', {
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
    browserInfo = {
      name: session.capabilities.browserName,
      version: session.capabilities.browserVersion,
      driver: session.capabilities['moz:geckodriverVersion'],
      headless: session.capabilities['moz:headless'],
      userAgent: session.capabilities.userAgent,
    }
    firefoxPid = session.capabilities['moz:processID'] as number
    console.log(JSON.stringify({ browser: browserInfo }))
    await webdriver(`/session/${sessionId}/moz/addon/install`, {
      path: temp,
      temporary: true,
    })
    await poll(async () => (results.length === 12 ? true : undefined))
  } else {
    browser = Bun.spawn(
      [
        process.env.CHROME_BINARY ??
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '--headless=new',
        `--user-data-dir=${profile}`,
        '--remote-debugging-port=0',
        '--no-first-run',
        '--no-default-browser-check',
        `--load-extension=${temp}`,
        'about:blank',
      ],
      { stdout: 'inherit', stderr: 'inherit' }
    )
    const port = await poll(async () => {
      try {
        const value = (
          await readFile(join(profile, 'DevToolsActivePort'), 'utf8')
        ).split('\n')[0]
        return value && PORT_NUMBER.test(value) && Number(value) > 0
          ? value
          : undefined
      } catch {
        return undefined
      }
    })
    const version = await (
      await fetch(`http://127.0.0.1:${port}/json/version`)
    ).json()
    browserInfo = version
    console.log(JSON.stringify({ browser: browserInfo }))
    await poll(async () => (results.length === 12 ? true : undefined))
    // Stop the real extension SW from a fixture page's CDP session. No normal
    // profile or unrelated extension target is connected or controlled.
    const target = await poll(async () => {
      const targets = (await (
        await fetch(`http://127.0.0.1:${port}/json/list`)
      ).json()) as { url: string; webSocketDebuggerUrl: string }[]
      return targets.find((t) => t.url.includes('/ui.html?restart=1'))
    })
    socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise<void>((resolve, reject) => {
      socket!.onopen = () => resolve()
      socket!.onerror = () => reject(Error('CDP connection failed'))
    })
    let messageId = 0
    const pending = new Map<
      number,
      {
        resolve: (value: Record<string, unknown>) => void
        reject: (error: Error) => void
      }
    >()
    const versions = new Map<string, Record<string, unknown>>()
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number
        method?: string
        params?: { versions: Record<string, unknown>[] }
        result: Record<string, unknown>
        error?: unknown
      }
      if (message.method === 'ServiceWorker.workerVersionUpdated')
        for (const v of message.params!.versions)
          versions.set(String(v.versionId), v)
      if (message.id) {
        const p = pending.get(message.id)
        pending.delete(message.id)
        if (message.error) p?.reject(Error(JSON.stringify(message.error)))
        else p?.resolve(message.result)
      }
    }
    const send = (method: string, params: Record<string, unknown> = {}) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const id = ++messageId
        pending.set(id, { resolve, reject })
        socket!.send(JSON.stringify({ id, method, params }))
      })
    const evaluate = async (expression: string) => {
      const result = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      })
      if (result.exceptionDetails)
        throw Error(JSON.stringify(result.exceptionDetails))
      return (result.result as { value: Record<string, unknown> }).value
    }
    try {
      const before = await evaluate('globalThis.__webextPopoutStageG.restore()')
      await send('ServiceWorker.enable')
      const version = await poll(async () =>
        [...versions.values()].find(
          (v) =>
            typeof v.scriptURL === 'string' &&
            v.scriptURL.endsWith('/popout-background.js') &&
            v.runningStatus === 'running'
        )
      )
      await send('ServiceWorker.stopWorker', { versionId: version.versionId })
      await poll(async () =>
        versions.get(String(version.versionId))?.runningStatus === 'stopped'
          ? true
          : undefined
      )
      const after = await evaluate('globalThis.__webextPopoutStageG.restore()')
      lifecycle = {
        versionId: version.versionId,
        observedStopped: true,
        before,
        after,
      }
      if (
        before.windowId !== after.windowId ||
        after.kind !== 'popout' ||
        typeof after.epoch !== 'string' ||
        before.epoch === after.epoch ||
        before.echo !== 'restart-check:isolated' ||
        after.echo !== before.echo ||
        after.stored !== after.echo
      )
        throw Error(JSON.stringify({ before, after }))
      results.push({
        name: 'real Service Worker stop, messaging/storage wake and session restoration',
        passed: true,
      })
      console.log(JSON.stringify(results.at(-1)))
      await send('Runtime.evaluate', {
        expression: 'void globalThis.__webextPopoutStageG.close()',
      })
    } catch (error) {
      results.push({
        name: 'real Service Worker stop, messaging/storage wake and session restoration',
        passed: false,
        error: String(error),
      })
      console.log(JSON.stringify(results.at(-1)))
    }
  }
  const failed = results.filter((result) => !result.passed)
  if (failed.length) throw new Error(`${failed.length} popout tests failed`)
  console.log(
    `${firefox ? 'Firefox' : 'Chrome'} popout: ${results.length} passed`
  )
} finally {
  if (process.env.POPOUT_REPORT)
    await writeFile(
      process.env.POPOUT_REPORT,
      JSON.stringify(
        { browser: browserInfo, results, ...(lifecycle ? { lifecycle } : {}) },
        null,
        2
      ) + '\n'
    )
  if (sessionId) {
    try {
      await webdriver(`/session/${sessionId}`, undefined, 'DELETE')
    } catch {}
  }
  if (firefoxPid) {
    try {
      process.kill(firefoxPid, 'SIGTERM')
    } catch {}
  }
  driver?.kill('SIGTERM')
  if (driver) await driver.exited
  socket?.close()
  browser?.kill('SIGINT')
  if (browser) await browser.exited
  server.stop(true)
  await rm(temp, { recursive: true, force: true })
  await rm(profile, { recursive: true, force: true })
}
