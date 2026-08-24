import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    'main/index': 'src/main/index.ts',
    'preload/index': 'src/preload/index.ts',
  },
  format: ['esm', 'cjs'],
  outDir: 'dist-electron',
  clean: true,
  dts: false,
  platform: 'node',
  target: 'node22',
  deps: {
    neverBundle: ['electron'],
  },
})
