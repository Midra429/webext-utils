import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'context/index': 'src/context/index.ts',
    'popout/index': 'src/popout/index.ts',
    'sidePanel/index': 'src/sidePanel/index.ts',
    'storage/index': 'src/storage/index.ts',
    'messaging/index': 'src/messaging/index.ts',
  },
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  fixedExtension: false,
  dts: true,
  clean: true,
})
