import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
for (const browser of ['chrome', 'firefox']) {
  const outdir = join(root, 'examples/dist', browser)
  await mkdir(outdir, { recursive: true })
  const result = await Bun.build({
    entrypoints: ['background', 'ui', 'isolated', 'main'].map((name) =>
      join(root, `examples/${name}.ts`)
    ),
    outdir,
    target: 'browser',
    format: 'iife',
  })
  if (!result.success) throw Error(String(result.logs))
  await copyFile(join(root, 'examples/ui.html'), join(outdir, 'ui.html'))
  await copyFile(
    join(root, `examples/manifest.${browser}.json`),
    join(outdir, 'manifest.json')
  )
  const manifest = JSON.parse(
    await readFile(join(outdir, 'manifest.json'), 'utf8')
  )
  if (manifest.manifest_version !== 3) throw Error('Expected MV3 example')
  console.log(`Example: ${outdir}`)
}
