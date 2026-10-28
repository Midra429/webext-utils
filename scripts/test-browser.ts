import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { arch, platform, release } from 'node:os'
import { join, resolve } from 'node:path'

import { launchFirefox } from './lib/firefox'

// Uses an unsigned temporary add-on in an isolated profile; never the user's profile.
const root = resolve(import.meta.dir, '..')
const chrome = process.argv.includes('--chrome')
const integration = process.argv.includes('--integration')
const review = process.argv.includes('--review')
const temp = await mkdtemp('/private/tmp/webext-utils-browser-')
const profile = await mkdtemp('/private/tmp/webext-utils-profile-')
const expected = new Set(
  review
    ? ['review:window-move', 'review:large-migration']
    : integration
      ? [
          'integration:five-modules',
          'integration:cross-view-watch',
          'integration:cleanup',
        ]
      : [
          'storage:native-areas',
          'storage:prototype-keys',
          'storage:native-watch',
          'storage:journal-recovery',
          'storage:context-lock',
          'storage:content-rpc',
          'storage:main-policy',
          'storage:main-watch',
          'bridge:main-background',
          'bridge:main-view',
          'bridge:main-isolated',
          'bridge:background-main',
          'bridge:view-main',
          'bridge:isolated-main',
          'bridge:policy',
          'bridge:cleanup',
          'background',
          'extension-tab',
          'options',
          'popout-before-verify',
          'popout',
          'isolated',
          'main-before-registration',
          'main',
          'messaging:view',
          'messaging:isolated',
          'messaging:background-view',
          'messaging:background-content',
        ]
)
const results = new Map<string, unknown>()
let complete!: () => void
const done = new Promise<void>((resolve) => {
  complete = resolve
})
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname === '/ready-for-popout') {
      return Response.json(
        [...expected].every(
          (name) => name === 'popout' || name === 'popout-before-verify'
        )
      )
    }
    if (new URL(request.url).pathname === '/report') {
      const result = (await request.json()) as { name: string; passed: boolean }
      console.log(JSON.stringify(result))
      results.set(result.name, result)
      expected.delete(result.name)
      if (!expected.size) complete()
      return new Response('ok', {
        headers: { 'Access-Control-Allow-Origin': '*' },
      })
    }
    return new Response(
      '<!doctype html><title>Associated tab fixture</title><p>Context fixture</p>',
      { headers: { 'Content-Type': 'text/html' } }
    )
  },
})
let browser: ReturnType<typeof Bun.spawn> | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let firefox: Awaited<ReturnType<typeof launchFirefox>> | undefined
let browserInfo: unknown
let failure: string | undefined
try {
  const origin = `http://127.0.0.1:${server.port}`
  const build = await Bun.build({
    entrypoints: (review
      ? ['review-background', 'review-view']
      : integration
        ? ['integration-background', 'integration-view', 'integration-content']
        : ['background', 'view', 'main', 'isolated']
    ).map((name) => join(root, `tests/browser/${name}.ts`)),
    outdir: temp,
    target: 'browser',
    format: 'iife',
    define: { TEST_ORIGIN: JSON.stringify(origin) },
  })
  if (!build.success) throw new Error(`Fixture build failed: ${build.logs}`)
  const html =
    '<!doctype html><meta charset="utf-8"><title>webext-utils fixture</title><script src="view.js" defer></script>'
  await writeFile(join(temp, 'shared.html'), html)
  await writeFile(join(temp, 'options.html'), html)
  await writeFile(
    join(temp, 'review.html'),
    html.replace('view.js', 'review-view.js')
  )
  await writeFile(
    join(temp, 'integrated.html'),
    html.replace('view.js', 'integration-view.js')
  )
  const page = integration ? 'integrated.html' : 'shared.html'
  const background = review
    ? 'review-background.js'
    : integration
      ? 'integration-background.js'
      : 'background.js'
  await writeFile(
    join(temp, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'webext-utils context test',
      version: '0.0.1',
      ...(!chrome
        ? {
            browser_specific_settings: {
              gecko: {
                id: 'webext-utils-test@example.com',
                strict_min_version: '145.0',
              },
            },
          }
        : { minimum_chrome_version: '142' }),
      permissions: chrome
        ? ['storage', 'sidePanel', 'tabs']
        : ['storage', 'tabs'],
      host_permissions: ['http://127.0.0.1/*'],
      background: chrome
        ? { service_worker: background }
        : { scripts: [background] },
      action: { default_popup: page },
      ...(chrome
        ? { side_panel: { default_path: page } }
        : {
            sidebar_action: {
              default_panel: page,
              default_title: 'Context fixture',
              open_at_install: false,
            },
          }),
      options_ui: { page: 'options.html', open_in_tab: true },
      content_scripts: review
        ? []
        : integration
          ? [
              {
                matches: ['http://127.0.0.1/*'],
                js: ['integration-content.js'],
                run_at: 'document_idle',
              },
            ]
          : [
              {
                matches: ['http://127.0.0.1/*'],
                js: ['isolated.js'],
                world: 'ISOLATED',
                run_at: 'document_start',
              },
              {
                matches: ['http://127.0.0.1/*'],
                js: ['main.js'],
                world: 'MAIN',
                run_at: 'document_start',
              },
            ],
    })
  )
  if (chrome) {
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
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        const port = (
          await readFile(join(profile, 'DevToolsActivePort'), 'utf8')
        ).split('\n')[0]
        browserInfo = await (
          await fetch(`http://127.0.0.1:${port}/json/version`)
        ).json()
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
    if (!browserInfo) throw Error('Chrome debugger did not start')
  } else {
    firefox = await launchFirefox(profile, temp)
    browserInfo = firefox.info
  }
  await Promise.race([
    done,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(new Error(`Browser test timeout; missing: ${[...expected]}`)),
        45000
      )
    }),
    ...(browser
      ? [
          browser.exited.then((code) => {
            throw new Error(`Browser exited early (${code})`)
          }),
        ]
      : []),
  ])
  const failed = [...results.values()].filter(
    (value) => !(value as { passed: boolean }).passed
  )
  if (failed.length) throw new Error(`${failed.length} browser cases failed`)
  console.log(
    `${chrome ? 'Chrome' : 'Firefox'} integration: ${results.size} passed`
  )
} catch (error) {
  failure = String(error)
  throw error
} finally {
  if (process.env.BROWSER_REPORT)
    await writeFile(
      process.env.BROWSER_REPORT,
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          os: { platform: platform(), release: release(), arch: arch() },
          browser: browserInfo,
          results: [...results.values()],
          missing: [...expected],
          ...(failure ? { failure } : {}),
        },
        null,
        2
      ) + '\n'
    )
  await firefox?.close()
  if (timer) clearTimeout(timer)
  browser?.kill('SIGINT')
  if (browser) await browser.exited
  server.stop(true)
  await rm(temp, { recursive: true, force: true })
  await rm(profile, { recursive: true, force: true })
}
