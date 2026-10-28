import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const markdownLink = /\]\(([^)]+)\)/g
const externalLink = /^(?:[a-z]+:|#)/i
const packedPath =
  /^(dist\/.*\.(?:js|d\.ts)$|docs\/(?:api|compatibility|context|integration|main-world|messaging|migrations|popout|side-panel|storage|testing)\.md$|examples\/(?:[^/]+\.(?:ts|html|json)|README\.md)$|package\.json$|README\.md$|LICENSE$)/
const temp = await mkdtemp(join(tmpdir(), 'webext-utils-consumer-'))

async function run(
  command: string[],
  cwd = temp,
  capture = false
): Promise<string> {
  const child = Bun.spawn(command, {
    cwd,
    stdout: capture ? 'pipe' : 'inherit',
    stderr: 'inherit',
    env: { ...process.env, NPM_CONFIG_CACHE: join(temp, 'npm-cache') },
  })
  const output = capture ? await new Response(child.stdout).text() : ''
  if ((await child.exited) !== 0)
    throw new Error(`Failed: ${command.join(' ')}`)
  return output
}

try {
  // Pack locally, without lifecycle scripts or registry access. Consumers only
  // see the extracted archive, never source paths or workspace self-resolution.
  const packResult = JSON.parse(
    await run(
      [
        'npm',
        'pack',
        '--offline',
        '--ignore-scripts',
        '--json',
        '--pack-destination',
        temp,
      ],
      root,
      true
    )
  ) as
    | Record<string, { filename: string; files: { path: string }[] }>
    | { filename: string; files: { path: string }[] }[]
  const [packed] = Array.isArray(packResult)
    ? packResult
    : Object.values(packResult)
  if (!packed) throw Error('Expected one packed archive')
  if (packed.files.some((file) => !packedPath.test(file.path)))
    throw Error('Unexpected development file in archive')
  for (const required of ['README.md', 'LICENSE', 'package.json'])
    if (!packed.files.some((file) => file.path === required))
      throw Error(`Missing required package file: ${required}`)
  const archive = join(temp, packed.filename)
  await run(['tar', '-xzf', archive, '-C', temp])
  const installed = join(temp, 'node_modules/@midra/webext-utils')
  await mkdir(join(temp, 'node_modules/@midra'), { recursive: true })
  await rename(join(temp, 'package'), installed)
  for (const file of packed.files.filter((file) => file.path.endsWith('.md'))) {
    const markdown = await readFile(join(installed, file.path), 'utf8')
    for (const [, target] of markdown.matchAll(markdownLink)) {
      if (!target || externalLink.test(target)) continue
      const path = target.split('#')[0]!
      if (path) await readFile(resolve(installed, dirname(file.path), path))
    }
  }
  await writeFile(
    join(temp, 'package.json'),
    JSON.stringify({ type: 'module' })
  )
  const bundles: Record<string, { minified: number; gzip: number }> = {}
  const measure = (name: string, code: string) => {
    bundles[name] = {
      minified: Buffer.byteLength(code),
      gzip: Bun.gzipSync(code).byteLength,
    }
  }
  const pkg = JSON.parse(
    await readFile(join(installed, 'package.json'), 'utf8')
  )
  if (Object.keys(pkg.dependencies ?? {}).length)
    throw new Error('Unexpected runtime dependencies')
  for (const path of [
    '.',
    './context',
    './messaging',
    './storage',
    './sidePanel',
    './popout',
  ]) {
    const entry = pkg.exports[path]
    await readFile(join(installed, entry.import))
    const declarations = await readFile(join(installed, entry.types), 'utf8')
    if (/\b(?:chrome|browser|Bun)\b|reference types=/.test(declarations))
      throw new Error('Ambient type dependency leaked')
  }
  await writeFile(
    join(temp, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        exactOptionalPropertyTypes: true,
        noEmit: true,
        module: 'ESNext',
        moduleResolution: 'Bundler',
        target: 'ES2022',
        types: [],
        lib: ['ES2022'],
      },
      files: [
        'consumer.ts',
        'messaging-consumer.ts',
        'storage-consumer.ts',
        'sidePanel-consumer.ts',
        'popout-consumer.ts',
      ],
    })
  )
  await writeFile(
    join(temp, 'popout-consumer.ts'),
    await readFile(join(root, 'tests/types/popout.ts'), 'utf8')
  )
  const types = await readFile(join(root, 'tests/types/context.ts'), 'utf8')
  const messagingTypes = await readFile(
    join(root, 'tests/types/messaging.ts'),
    'utf8'
  )
  await writeFile(
    join(temp, 'consumer.ts'),
    `import { webextContext as rootContext, webextPopout as rootPopout } from '@midra/webext-utils'\nvoid [rootContext,rootPopout]\n${types}`
  )
  await writeFile(join(temp, 'messaging-consumer.ts'), messagingTypes)
  await writeFile(
    join(temp, 'storage-consumer.ts'),
    await readFile(join(root, 'tests/types/storage.ts'), 'utf8')
  )
  await writeFile(
    join(temp, 'sidePanel-consumer.ts'),
    await readFile(join(root, 'tests/types/sidePanel.ts'), 'utf8')
  )
  await run([
    'bun',
    join(root, 'node_modules/typescript/bin/tsc'),
    '-p',
    join(temp, 'tsconfig.json'),
  ])
  const config = JSON.parse(await readFile(join(temp, 'tsconfig.json'), 'utf8'))
  await writeFile(
    join(temp, 'empty-consumer.ts'),
    await readFile(join(root, 'tests/types/messaging-empty.ts'), 'utf8')
  )
  await writeFile(
    join(temp, 'tsconfig.empty.json'),
    JSON.stringify({ ...config, files: ['empty-consumer.ts'] })
  )
  await run([
    'bun',
    join(root, 'node_modules/typescript/bin/tsc'),
    '-p',
    join(temp, 'tsconfig.empty.json'),
  ])
  // Both supported TS resolvers must follow the installed exports and chunks.
  await writeFile(
    join(temp, 'tsconfig.node.json'),
    JSON.stringify({
      ...config,
      compilerOptions: {
        ...config.compilerOptions,
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
      },
    })
  )
  await run([
    'bun',
    join(root, 'node_modules/typescript/bin/tsc'),
    '-p',
    join(temp, 'tsconfig.node.json'),
  ])
  // Compile the shipped examples against the packed declarations too.
  await writeFile(
    join(temp, 'tsconfig.examples.json'),
    JSON.stringify({
      ...config,
      compilerOptions: { ...config.compilerOptions, lib: ['ES2022', 'DOM'] },
      files: ['background', 'ui', 'main', 'isolated', 'shared'].map(
        (name) => `node_modules/@midra/webext-utils/examples/${name}.ts`
      ),
    })
  )
  await run([
    'bun',
    join(root, 'node_modules/typescript/bin/tsc'),
    '-p',
    join(temp, 'tsconfig.examples.json'),
  ])
  // Fresh processes: poisoned globals prove import does not access browser state.
  for (const path of [
    '@midra/webext-utils',
    '@midra/webext-utils/context',
    '@midra/webext-utils/messaging',
    '@midra/webext-utils/storage',
    '@midra/webext-utils/sidePanel',
    '@midra/webext-utils/popout',
  ]) {
    await run([
      'node',
      '--input-type=module',
      '-e',
      `
      for (const name of ['window', 'document', 'location', 'chrome', 'browser']) {
        Object.defineProperty(globalThis, name, {get() {throw Error('Import accessed ' + name)}})
      }
      await import(${JSON.stringify(path)})
    `,
    ])
  }
  await run([
    'node',
    '--input-type=module',
    '-e',
    `
    import { webextContext } from '@midra/webext-utils/context'
    import { webextMessaging } from '@midra/webext-utils/messaging'
    if (webextContext.get().kind !== 'unknown') throw Error('SSR classification')
    try { await webextContext.resolve(); throw Error('Expected failure') }
    catch (error) { if (error.code !== 'CONTEXT_UNAVAILABLE') throw error }
    Object.defineProperty(globalThis,'crypto',{value:undefined,configurable:true})
    const messaging=webextMessaging()
    for (const operation of [()=>messaging.send('ssr'),()=>messaging.ready()]) {
      try { await operation(); throw Error('Expected SSR messaging failure') }
      catch(error) {if(error.code!=='CONTEXT_UNAVAILABLE')throw error}
    }
    messaging.dispose()
    const {webextSidePanel}=await import('@midra/webext-utils/sidePanel')
    try {await webextSidePanel.open(); throw Error('Expected SSR sidePanel failure')}
    catch(error) {if(error.code!=='CONTEXT_UNAVAILABLE')throw error}
    const {webextPopout}=await import('@midra/webext-utils/popout')
    if(await webextPopout.getCurrent()!==undefined)throw Error('SSR popout current')
    try {await webextPopout.open({source:'popup'}); throw Error('Expected SSR popout failure')}
    catch(error) {if(error.code!=='CONTEXT_UNAVAILABLE')throw error}
    const {webextStorage}=await import('@midra/webext-utils/storage')
    const storage=webextStorage()
    try {await storage.get('ssr'); throw Error('Expected SSR storage failure')}
    catch(error) {if(error.code!=='CONTEXT_UNAVAILABLE')throw error}
  `,
  ])
  await writeFile(
    join(temp, 'entry-messaging.ts'),
    `import { webextMessaging } from ${JSON.stringify(join(installed, 'dist/messaging/index.js'))}; console.log(webextMessaging())`
  )
  const messagingBundle = await Bun.build({
    entrypoints: [join(temp, 'entry-messaging.ts')],
    minify: true,
  })
  if (!messagingBundle.success)
    throw new Error('Messaging consumer bundle failed')
  const messagingCode = await messagingBundle.outputs[0]!.text()
  measure('messaging', messagingCode)
  console.log(
    `Messaging bundle: ${Buffer.byteLength(messagingCode)} bytes (${Bun.gzipSync(messagingCode).byteLength} bytes gzip)`
  )
  await writeFile(
    join(temp, 'entry-storage.ts'),
    `import { webextStorage } from ${JSON.stringify(join(installed, 'dist/storage/index.js'))}; console.log(webextStorage())`
  )
  const storageBundle = await Bun.build({
    entrypoints: [join(temp, 'entry-storage.ts')],
    minify: true,
  })
  if (!storageBundle.success) throw new Error('Storage consumer bundle failed')
  const storageCode = await storageBundle.outputs[0]!.text()
  measure('storage', storageCode)
  console.log(
    `Storage bundle: ${Buffer.byteLength(storageCode)} bytes (${Bun.gzipSync(storageCode).byteLength} bytes gzip)`
  )
  await writeFile(
    join(temp, 'entry-sidePanel.ts'),
    `import { webextSidePanel } from ${JSON.stringify(join(installed, 'dist/sidePanel/index.js'))}; console.log(webextSidePanel)`
  )
  const sidePanelBundle = await Bun.build({
    entrypoints: [join(temp, 'entry-sidePanel.ts')],
    minify: true,
  })
  if (!sidePanelBundle.success)
    throw new Error('SidePanel consumer bundle failed')
  const sidePanelCode = await sidePanelBundle.outputs[0]!.text()
  if (/startBackground|runtime\.connect|storage\.local/.test(sidePanelCode))
    throw new Error('Unrelated feature bundled in sidePanel')
  measure('sidePanel', sidePanelCode)
  console.log(
    `SidePanel bundle: ${Buffer.byteLength(sidePanelCode)} bytes (${Bun.gzipSync(sidePanelCode).byteLength} bytes gzip)`
  )
  await writeFile(
    join(temp, 'entry-popout.ts'),
    `import {webextPopout} from ${JSON.stringify(join(installed, 'dist/popout/index.js'))}; console.log(webextPopout)`
  )
  const popoutBundle = await Bun.build({
    entrypoints: [join(temp, 'entry-popout.ts')],
    minify: true,
  })
  if (!popoutBundle.success) throw Error('Popout consumer bundle failed')
  const popoutCode = await popoutBundle.outputs[0]!.text()
  measure('popout', popoutCode)
  console.log(
    `Popout bundle: ${Buffer.byteLength(popoutCode)} bytes (${Bun.gzipSync(popoutCode).byteLength} bytes gzip)`
  )
  // Compare a root named import with the isolated subpath after tree shaking.
  await writeFile(
    join(temp, 'entry-root.ts'),
    `import { webextContext } from '@midra/webext-utils'; console.log(webextContext.get())`
  )
  const rootBundle = await Bun.build({
    entrypoints: [join(temp, 'entry-root.ts')],
    minify: true,
  })
  if (!rootBundle.success) throw Error('Root tree shaking failed')
  const rootCode = await rootBundle.outputs[0]!.text()
  if (/startBackground|runtime\.connect|storage\.local/.test(rootCode))
    throw Error('Root context import retained unrelated modules')
  await writeFile(join(temp, 'shaken.mjs'), rootCode)
  await run(['node', join(temp, 'shaken.mjs')])
  // The context subpath must not pull in other feature implementations.
  await writeFile(
    join(temp, 'entry.ts'),
    `import { webextContext } from ${JSON.stringify(join(installed, 'dist/context/index.js'))}; console.log(webextContext.get())`
  )
  const bundle = await Bun.build({
    entrypoints: [join(temp, 'entry.ts')],
    minify: true,
  })
  if (!bundle.success) throw new Error('Consumer bundle failed')
  const code = await bundle.outputs[0]!.text()
  if (/startBackground|runtime\.connect|storage\.local/.test(code))
    throw new Error('Unrelated feature bundled')
  if (Math.abs(Buffer.byteLength(rootCode) - Buffer.byteLength(code)) > 256)
    throw Error('Root/subpath context bundle size diverged')
  measure('context', code)
  measure('rootContext', rootCode)
  if (process.env.PACKAGE_REPORT)
    await writeFile(
      process.env.PACKAGE_REPORT,
      JSON.stringify(
        {
          bundles,
          runtimeDependencies: Object.keys(pkg.dependencies ?? {}),
          checks: [
            'offline archive',
            'packaged document links',
            'exports',
            'Bundler types',
            'NodeNext types',
            'shipped examples',
            'SSR',
            'side-effect-free imports',
            'root tree shaking',
            'shaken bundle execution',
          ],
        },
        null,
        2
      ) + '\n'
    )
  console.log(
    `Package checks passed; packed consumer, Node ESM, root tree shaking;  context consumer bundle: ${Buffer.byteLength(code)} bytes (${Bun.gzipSync(code).byteLength} bytes gzip)`
  )
} finally {
  await rm(temp, { recursive: true, force: true })
}
