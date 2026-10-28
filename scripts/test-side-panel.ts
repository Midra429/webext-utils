import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// Only isolated profiles and the extension fixture created here are controlled.
const root = resolve(import.meta.dir, '..')
const firefox = process.argv.includes('--firefox')
const manual = process.argv.includes('--manual')
const temp = await mkdtemp('/private/tmp/webext-side-panel-')
const profile = await mkdtemp('/private/tmp/webext-side-profile-')
let readyStep = -1
const results: { name: string; passed: boolean; error?: string }[] = []
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname === '/ready') {
      readyStep = Number(await request.text())
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
let socket: WebSocket | undefined
let driver: ReturnType<typeof Bun.spawn> | undefined
let sessionId: string | undefined
let webdriverUrl = ''
let firefoxPid: number | undefined
let browserInfo: unknown
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
  throw new Error(`Side panel test timeout (${results.length}/12 reports)`)
}
try {
  const build = await Bun.build({
    entrypoints: [join(root, 'tests/browser/sidePanel.ts')],
    outdir: temp,
    target: 'browser',
    format: 'iife',
    define: { TEST_ORIGIN: JSON.stringify(`http://127.0.0.1:${server.port}`) },
  })
  if (!build.success) throw new Error(String(build.logs))
  await writeFile(
    join(temp, 'test.html'),
    '<!doctype html><html lang="en"><meta charset="utf-8"><title>Side panel fixture</title><body><script src="sidePanel.js" defer></script>'
  )
  await writeFile(
    join(temp, 'panel.html'),
    '<!doctype html><title>Panel fixture</title><p>Native side panel</p>'
  )
  await writeFile(
    join(temp, 'background.js'),
    `const api = globalThis.browser ?? chrome; api.tabs.create({url:api.runtime.getURL('test.html')})`
  )
  await writeFile(
    join(temp, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'webext-utils side panel test',
      version: '0.0.1',
      permissions: firefox ? [] : ['sidePanel'],
      host_permissions: ['http://127.0.0.1/*'],
      action: {},
      ...(firefox
        ? {
            browser_specific_settings: {
              gecko: {
                id: 'webext-side-panel@example.com',
                strict_min_version: '145.0',
              },
            },
            background: { scripts: ['background.js'] },
            sidebar_action: {
              default_panel: 'panel.html',
              default_title: 'Fixture',
              open_at_install: false,
            },
          }
        : {
            minimum_chrome_version: '142',
            background: { service_worker: 'background.js' },
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
    await poll(async () => {
      const handles = (await webdriver(
        `/session/${sessionId}/window/handles`
      )) as string[]
      for (const handle of handles) {
        await webdriver(`/session/${sessionId}/window`, { handle })
        const url = await webdriver(`/session/${sessionId}/url`)
        if (typeof url === 'string' && url.endsWith('/test.html')) return true
      }
      return undefined
    })
    if (manual) {
      console.log(
        'Click the visible fixture button for each of the ten steps. No privileged WebDriver access is enabled.'
      )
    } else {
      for (let step = 0; step < 10; step++) {
        await poll(async () => (readyStep === step ? true : undefined))
        const element = (await webdriver(`/session/${sessionId}/element`, {
          using: 'css selector',
          value: 'button',
        })) as Record<string, string>
        const id = element['element-6066-11e4-a52e-4f735466cecf']
        await poll(async () =>
          (await webdriver(`/session/${sessionId}/element/${id}/enabled`))
            ? true
            : undefined
        )
        await new Promise((resolve) => setTimeout(resolve, 600))
        await webdriver(`/session/${sessionId}/element/${id}/click`, {})
      }
    }
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
        return (
          await readFile(join(profile, 'DevToolsActivePort'), 'utf8')
        ).split('\n')[0]
      } catch {
        return undefined
      }
    })
    const target = await poll(async () => {
      const targets = (await (
        await fetch(`http://127.0.0.1:${port}/json/list`)
      ).json()) as { url: string; webSocketDebuggerUrl: string }[]
      return targets.find((target) => target.url.endsWith('/test.html'))
    })
    socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise<void>((resolve, reject) => {
      socket!.onopen = () => resolve()
      socket!.onerror = () => reject(new Error('CDP connection failed'))
    })
    let id = 0
    const pending = new Map<
      number,
      {
        resolve: (value: Record<string, unknown>) => void
        reject: (error: Error) => void
      }
    >()
    socket.onmessage = (event) => {
      const response = JSON.parse(String(event.data)) as {
        id?: number
        result: Record<string, unknown>
        error?: unknown
      }
      if (!response.id) return
      const request = pending.get(response.id)
      pending.delete(response.id)
      if (response.error)
        request?.reject(new Error(JSON.stringify(response.error)))
      else request?.resolve(response.result)
    }
    const send = (method: string, params: Record<string, unknown> = {}) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const messageId = ++id
        pending.set(messageId, { resolve, reject })
        socket!.send(JSON.stringify({ id: messageId, method, params }))
      })
    const evaluate = async (expression: string) => {
      const response = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
      })
      if (response.exceptionDetails)
        throw new Error(JSON.stringify(response.exceptionDetails))
      return (response.result as { value?: unknown }).value
    }
    browserInfo = await send('Browser.getVersion')
    console.log(JSON.stringify({ browser: browserInfo }))
    await send('Page.bringToFront')
    for (let step = 0; step < 10; step++) {
      await poll(async () =>
        (await evaluate(
          `document.querySelector('button')?.dataset.step === '${step}' && !document.querySelector('button').disabled`
        ))
          ? true
          : undefined
      )
      await new Promise((resolve) => setTimeout(resolve, 600))
      // Trusted input dispatch, not element.click() or Runtime userGesture flags.
      await send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: 70,
        y: 25,
        button: 'left',
        clickCount: 1,
      })
      await send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: 70,
        y: 25,
        button: 'left',
        clickCount: 1,
      })
    }
    await poll(async () => (results.length === 12 ? true : undefined))
  }
  const failed = results.filter((result) => !result.passed)
  if (failed.length) throw new Error(`${failed.length} side panel tests failed`)
  console.log(
    `${firefox ? 'Firefox' : 'Chrome'} sidePanel: ${results.length} passed`
  )
} finally {
  if (process.env.SIDE_PANEL_REPORT)
    await writeFile(
      process.env.SIDE_PANEL_REPORT,
      JSON.stringify({ browser: browserInfo, results }, null, 2) + '\n'
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
