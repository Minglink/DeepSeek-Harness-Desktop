/** Normal Host build and publication preserve the bootstrap's late core-module boundary. */
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as tar from 'tar'
import { afterEach, expect, it } from 'vitest'
import configurations from '../tsdown.config.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir(), 'dsh-bootstrap-publication-')) || lstatSync(root).isSymbolicLink()
      || realpathSync(root).toLowerCase() !== resolve(root).toLowerCase()) throw new Error('Unexpected fixture cleanup target')
    rmSync(root, { recursive: true, force: true })
  }
})

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function fixture() { const root = mkdtempSync(join(tmpdir(), 'dsh-bootstrap-publication-')); roots.push(root); return root }
function config(name: string): Record<string, unknown> {
  const candidates: readonly unknown[] = Array.isArray(configurations) ? configurations : []
  const found = candidates.find(value => record(value) && Array.isArray(value.entry) && value.entry.includes(`lib/types/${name}.js`))
  if (!record(found)) throw new Error(`Missing Host entry ${name}`)
  return found
}
function manifest(): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  if (!record(value)) throw new Error('Invalid Host manifest')
  return value
}
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !/^(?:DSH_|DEEPSEEK_|NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE)/iu.test(name)
  && !/(?:SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIAL|AUTH)/iu.test(name)))

it('normally builds and publishes the bootstrap and managed hook modules alongside the existing restart module', () => {
  const files = manifest().files
  if (!Array.isArray(files)) throw new Error('Missing Host publication list')
  for (const name of ['bootstrap', 'managed-harmony', 'managed-harmony-pins']) {
    expect(config(name).entry).toEqual([`lib/types/${name}.js`])
    expect(files).toContain(`lib/${name}.js`)
    expect(files).toContain(`lib/types/${name}.d.ts`)
  }
  expect(files).toContain('lib/managed-restart.js')
  expect(config('managed-restart')).toBeDefined()
})

it('uses the production compiler configuration to install hooks before the separately loaded index imports', () => {
  const root = fixture(), source = join(root, 'source'), lib = join(root, 'lib')
  const sentinel = join(root, 'node_modules', '@dsh-owned', 'import-order-sentinel')
  mkdirSync(source); mkdirSync(sentinel, { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'owned-bootstrap-probe', version: '1.0.0', type: 'module',
    dependencies: { '@dsh-owned/import-order-sentinel': '1.0.0' } }))
  writeFileSync(join(sentinel, 'package.json'), JSON.stringify({ name: '@dsh-owned/import-order-sentinel', version: '1.0.0', type: 'module', exports: './index.js' }))
  writeFileSync(join(sentinel, 'index.js'), "import {appendFileSync} from 'node:fs';appendFileSync(process.env.OWNED_IMPORT_LOG,'core-imported\\n')")
  writeFileSync(join(source, 'bootstrap.js'), "import {appendFileSync} from 'node:fs';appendFileSync(process.env.OWNED_IMPORT_LOG,'hooks-installed\\n');await Promise.resolve();const host=await import('./index.js');host.run()")
  writeFileSync(join(source, 'index.js'), "import '@dsh-owned/import-order-sentinel';import {appendFileSync} from 'node:fs';export function run(){appendFileSync(process.env.OWNED_IMPORT_LOG,'host-started\\n')}")
  const selected = ['bootstrap', 'index'].map(name => ({ ...config(name), entry: [join(source, `${name}.js`)], outDir: lib }))
  const configPath = join(root, 'tsdown.config.mjs')
  writeFileSync(configPath, `export default ${JSON.stringify(selected)}`)
  const require = createRequire(import.meta.url), toolManifest = require.resolve('tsdown/package.json')
  const tool = join(dirname(toolManifest), 'dist', 'run.mjs')
  expect(existsSync(tool)).toBe(true)
  const compiled = spawnSync(process.execPath, [tool, '--config', configPath, '--config-loader', 'native'], {
    cwd: root, env: environment, windowsHide: true, encoding: 'utf8', timeout: 20_000, maxBuffer: 8 * 1024 * 1024,
  })
  expect(compiled.error).toBeUndefined()
  expect(compiled.status, compiled.stderr).toBe(0)
  const trace = join(root, 'trace.log')
  const run = spawnSync(process.execPath, [join(lib, 'bootstrap.js')], {
    cwd: root, env: { ...environment, OWNED_IMPORT_LOG: trace }, windowsHide: true, encoding: 'utf8', timeout: 10_000,
  })
  expect(run.error).toBeUndefined()
  expect(run.status, run.stderr).toBe(0)
  expect(readFileSync(trace, 'utf8').trim().split(/\r?\n/u)).toEqual(['hooks-installed', 'core-imported', 'host-started'])
}, 40_000)

it('includes every new runtime entry in a real script-disabled normal package fixture', async () => {
  const root = fixture(), value = manifest()
  if (!Array.isArray(value.files) || !value.files.every(name => typeof name === 'string')) throw new Error('Invalid Host publication list')
  for (const name of value.files) {
    const file = resolve(root, name)
    if (!file.startsWith(root + sep)) throw new Error('Publication path escaped fixture')
    mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, name.endsWith('.d.ts') ? 'export {}' : 'owned publication fixture')
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify({ ...value, dependencies: {}, devDependencies: {} }))
  const packed = join(root, 'packed'); mkdirSync(packed)
  const pnpm = fileURLToPath(new URL('../../desktop/node_modules/pnpm/bin/pnpm.mjs', import.meta.url))
  const run = spawnSync(process.execPath, [pnpm, '--config.ignore-scripts=true', '--config.manage-package-manager-versions=false', 'pack', '--pack-destination', packed], {
    cwd: root, env: environment, windowsHide: true, encoding: 'utf8', timeout: 20_000, maxBuffer: 8 * 1024 * 1024,
  })
  expect(run.error).toBeUndefined()
  expect(run.status, run.stderr).toBe(0)
  const entries: string[] = [], archives = readdirSync(packed).filter(name => name.endsWith('.tgz'))
  expect(archives).toHaveLength(1)
  const archive = archives[0]
  if (archive === undefined) throw new Error('Missing fixture archive')
  await tar.t({ file: join(packed, archive), onReadEntry: (entry) => { entries.push(entry.path) } })
  for (const name of ['bootstrap', 'managed-harmony', 'managed-harmony-pins']) {
    expect(entries).toContain(`package/lib/${name}.js`)
    expect(entries).toContain(`package/lib/types/${name}.d.ts`)
  }
}, 30_000)
