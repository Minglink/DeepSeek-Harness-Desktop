import { defineConfig, type UserConfig } from 'tsdown'

export default defineConfig(['index', 'cli', 'services', 'native-path', 'host-log', 'profile-links', 'managed-restart',
  'bootstrap', 'managed-harmony', 'managed-harmony-pins'].map((name): UserConfig => ({
  entry: ['lib/types/' + name + '.js'],
  outDir: 'lib',
  format: ['esm'],
  outputOptions: { codeSplitting: false },
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  // The bootstrap installs module hooks before loading the Host's core imports.
  // Inlining index would hoist its external static imports above that setup.
  ...(name === 'bootstrap' ? { deps: { neverBundle: ['./index.js'] } } : {}),
})))
