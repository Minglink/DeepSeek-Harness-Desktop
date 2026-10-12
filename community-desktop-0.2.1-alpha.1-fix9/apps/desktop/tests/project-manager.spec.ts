import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveDesktopPaths } from '../src/paths.ts'
import { DesktopProjectManager, missingBundledPlugins } from '../src/project-manager.ts'
import { readProfilePlugins } from '@deepseek-ai/dsh-app-boot'
import { runtimeFixture } from './runtime-fixture.ts'

const roots: string[] = []
const startupRunner = fileURLToPath(new URL('../../../packages/subprocess/subprocess-local/lib/runner.js', import.meta.url))
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-test-'))
  roots.push(root)
  return root
}
function seedPlugin(manager: DesktopProjectManager): void {
  const path = join(manager.paths.profile, 'package.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
    dependencies: Record<string, string>
    dsh: { profile: { bundles: string[] } }
  }
  manifest.dependencies.plugin = '1.0.0'
  manifest.dsh.profile.bundles.push('plugin')
  writeFileSync(path, JSON.stringify(manifest))
  const directory = join(manager.paths.profile, 'node_modules/plugin')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'plugin', version: '1.0.0', dsh: { bundle: { patch: 'bundle.yml' } } }))
  writeFileSync(join(directory, 'bundle.yml'), '[]\n')
}
function plugins(manager: DesktopProjectManager) {
  return readProfilePlugins({ binName: 'dsh', profileDir: manager.paths.profile,
    installAnchor: join(manager.runtime.dsh, 'node_modules/@deepseek-ai/dsh/package.json') }).dependencies
    .map(({ name, version, enabled }) => ({ name, version, enabled }))
}
function setup(): { root: string; manager: DesktopProjectManager } {
  const root = temporaryRoot()
  const dsh = join(root, 'resources', 'dsh')
  runtimeFixture(dsh)
  return { root, manager: new DesktopProjectManager(resolveDesktopPaths(join(root, '.dsh')), { dsh }) }
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('desktop external plugin profile', () => {
  it.each(process.platform === 'win32' ? [0, 7, 'timeout', 'cleanup'] : [0, 7, 'timeout'])('protects author sources before a refreshing pnpm operation and handles exit %s', async (exitCode) => {
    const { root, manager } = setup()
    await manager.applyRelease()
    const profile = manager.paths.profile
    const target = join(root, '.dsh/plugins/author-plugin')
    const installed = join(profile, 'node_modules/author-plugin')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'package.json'), JSON.stringify({ name: 'author-plugin', version: '1.0.0' }))
    writeFileSync(join(target, 'engine.exe'), 'retain full engine source')
    mkdirSync(dirname(installed), { recursive: true })
    symlinkSync(target, installed, process.platform === 'win32' ? 'junction' : 'dir')
    const manifestPath = join(profile, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    manifest.dependencies['author-plugin'] = 'file:../../plugins/author-plugin'
    manifest.dsh.profile.bundles.push('author-plugin')
    writeFileSync(manifestPath, JSON.stringify(manifest))
    writeFileSync(join(profile, 'pnpm-lock.yaml'), 'prior lock')
    const archives = join(manager.runtime.dsh, 'desktop-packages')
    mkdirSync(archives, { recursive: true })
    writeFileSync(join(archives, 'dsh-community-0.2.1-alpha.1.tgz'), 'new bundled market content')
    const pnpm = join(root, 'fake-protected-pnpm.mjs')
    writeFileSync(pnpm, [
      "import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'",
      "const link = 'node_modules/author-plugin'",
      'if (existsSync(link) && lstatSync(link).isSymbolicLink()) { rmSync(realpathSync(link), { recursive: true }); process.exit(99) }',
      "mkdirSync(link, { recursive: true }); writeFileSync(link + '/pnpm-copy', 'replacement')",
      "mkdirSync('node_modules/dsh-community', { recursive: true })",
      "writeFileSync('pnpm-protection-observed', 'external junction was detached')",
      typeof exitCode === 'number' ? `process.exit(${exitCode})` : 'setInterval(() => {}, 1000)',
    ].join('\n'))
    const brokenRunner = join(root, 'failed-runner.mjs')
    if (exitCode === 'cleanup') writeFileSync(brokenRunner, 'process.exit(29)')
    const upgraded = new DesktopProjectManager(manager.paths, { ...manager.runtime, pnpm }, {
      runner: exitCode === 'cleanup' ? brokenRunner : startupRunner, config: { timeoutMs: 1_000 },
    })
    if (exitCode === 'cleanup') {
      await expect(upgraded.applyRelease()).rejects.toMatchObject({ code: 'startup-install-cleanup-failed', quiescent: false })
      expect(readFileSync(join(target, 'engine.exe'), 'utf8')).toBe('retain full engine source')
      expect(existsSync(installed)).toBe(false)
      expect(existsSync(join(profile, 'pnpm-protection-observed'))).toBe(false)
      return
    }
    if (exitCode === 'timeout') await expect(upgraded.applyRelease()).rejects.toMatchObject({ code: 'startup-install-timeout', quiescent: true })
    else await upgraded.applyRelease()
    expect(readFileSync(join(profile, 'pnpm-protection-observed'), 'utf8')).toBe('external junction was detached')
    expect(readFileSync(join(target, 'engine.exe'), 'utf8')).toBe('retain full engine source')
    expect(realpathSync(installed)).toBe(realpathSync(target))
    expect(lstatSync(installed).isSymbolicLink()).toBe(true)
    const next = JSON.parse(readFileSync(manifestPath, 'utf8')) as typeof manifest
    expect(next.dependencies['author-plugin']).toBe(manifest.dependencies['author-plugin'])
    expect(next.dsh.profile.bundles).toContain('author-plugin')
    expect(readdirSync(join(profile, 'node_modules')).some(name => name.startsWith('.desktop-local-'))).toBe(false)
  })

  it('stops preparation when a local source cannot be restored after the package operation', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    const profile = manager.paths.profile
    const target = join(root, '.dsh/plugins/author-plugin')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'package.json'), JSON.stringify({ name: 'author-plugin', version: '1.0.0' }))
    const manifestPath = join(profile, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies: Record<string, string> }
    manifest.dependencies['author-plugin'] = 'file:../../plugins/author-plugin'
    writeFileSync(manifestPath, JSON.stringify(manifest))
    mkdirSync(join(profile, 'node_modules'), { recursive: true })
    symlinkSync(target, join(profile, 'node_modules/author-plugin'), process.platform === 'win32' ? 'junction' : 'dir')
    const archives = join(manager.runtime.dsh, 'desktop-packages')
    mkdirSync(archives, { recursive: true })
    writeFileSync(join(archives, 'dsh-community-0.2.1-alpha.1.tgz'), 'new market content')
    const pnpm = join(root, 'fake-source-changed.mjs')
    writeFileSync(pnpm, "import { writeFileSync } from 'node:fs'\nwriteFileSync('../../plugins/author-plugin/package.json', '{}')\n")
    const upgraded = new DesktopProjectManager(manager.paths, { ...manager.runtime, pnpm }, { runner: startupRunner })
    await expect(upgraded.applyRelease()).rejects.toThrow('local package source protection failed')
    expect(existsSync(manager.paths.lock)).toBe(false)
  })

  it('reconciles packages after retiring dependencies from an already installed profile', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    const profile = manager.paths.profile
    const manifestPath = join(profile, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      dependencies: Record<string, string>; dsh: { profile: { bundles: string[] } }
    }
    Object.assign(manifest.dependencies, { 'dsh-community': '0.2.1-alpha.1', dshmarket: '1.66.8' })
    manifest.dsh.profile.bundles.push('dsh-community', 'dshmarket')
    writeFileSync(manifestPath, JSON.stringify(manifest))
    mkdirSync(join(profile, 'node_modules/dsh-community'), { recursive: true })
    mkdirSync(join(profile, 'node_modules/dshmarket'), { recursive: true })
    writeFileSync(join(profile, 'pnpm-lock.yaml'), 'old lock\n')
    const pnpm = join(root, 'fake-pnpm.mjs')
    writeFileSync(pnpm, "import { writeFileSync } from 'node:fs'\nwriteFileSync('pnpm-reconciled', process.argv.slice(2).join(' '))\nwriteFileSync('pnpm-lock.yaml', 'reconciled lock\\n')\n")
    const upgrading = new DesktopProjectManager(manager.paths, { ...manager.runtime, pnpm }, { runner: startupRunner })

    await upgrading.applyRelease()

    expect(readFileSync(join(profile, 'pnpm-reconciled'), 'utf8')).toContain('install --ignore-scripts')
    expect(readFileSync(join(profile, 'pnpm-lock.yaml'), 'utf8')).toBe('reconciled lock\n')
    expect((JSON.parse(readFileSync(manifestPath, 'utf8')) as typeof manifest).dependencies).not.toHaveProperty('dshmarket')
    expect(existsSync(join(profile, 'node_modules/dshmarket'))).toBe(false)
  })

  it('retires the old market and theme while preserving Cordis, custom metadata, and YAML expressions', async () => {
    const { manager } = setup()
    await manager.applyRelease()
    const profile = manager.paths.profile
    const path = join(profile, 'package.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
      dependencies: Record<string, string>; dsh: { profile: { bundles: string[] } }
    }
    Object.assign(manifest.dependencies, { dshmarket: '1.66.8', 'deepseek-ai-cordis': '4.0.5', '@deepseek-ai/cordis': '4.0.2' })
    manifest.dsh.profile.bundles.push('dshmarket', 'deepseek-ai-cordis')
    writeFileSync(path, JSON.stringify({ ...manifest, description: 'Retained metadata', custom: { keep: true } }))
    for (const name of ['dshmarket', 'deepseek-ai-cordis', '@deepseek-ai/cordis']) {
      const directory = join(profile, 'node_modules', ...name.split('/'))
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'sentinel'), 'retained core')
    }
    const original = '- insert:\n    - id: dsh-theme\n      name: deepseek-ai-cordis\n    - id: custom-tool\n      name: custom-tool\n      config:\n        enabled: !!js ctx.enabled\n- id: dsh-market\n  disabled: true\n'
    writeFileSync(join(profile, 'cordis.patch.yml'), original)
    writeFileSync(join(profile, 'pnpm-lock.yaml'), 'old lock\n')

    await manager.applyRelease()

    const next = JSON.parse(readFileSync(path, 'utf8')) as typeof manifest
    expect(next).toMatchObject({ description: 'Retained metadata', custom: { keep: true } })
    expect(next.dependencies).not.toHaveProperty('dshmarket')
    expect(next.dependencies).not.toHaveProperty('deepseek-ai-cordis')
    expect(next.dependencies['@deepseek-ai/cordis']).toBe('4.0.2')
    expect(next.dsh.profile.bundles).not.toContain('dshmarket')
    expect(next.dsh.profile.bundles).not.toContain('deepseek-ai-cordis')
    expect(existsSync(join(profile, 'node_modules/dshmarket'))).toBe(false)
    expect(existsSync(join(profile, 'node_modules/deepseek-ai-cordis'))).toBe(false)
    expect(readFileSync(join(profile, 'node_modules/@deepseek-ai/cordis/sentinel'), 'utf8')).toBe('retained core')
    expect(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')).toContain('!!js ctx.enabled')
    expect(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')).not.toMatch(/dsh-theme|dsh-market|deepseek-ai-cordis/)
    const backup = readdirSync(profile).find(name => name.startsWith('cordis.patch.yml.bak-community-'))
    expect(backup).toBeDefined()
    expect(readFileSync(join(profile, backup!), 'utf8')).toBe(original)
    expect(existsSync(join(profile, 'pnpm-lock.yaml'))).toBe(false)
  })

  it('unlinks a retired package junction without removing files in its target', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    const target = join(root, 'retired-theme-source')
    mkdirSync(target)
    writeFileSync(join(target, 'sentinel'), 'retain')
    mkdirSync(join(manager.paths.profile, 'node_modules'), { recursive: true })
    symlinkSync(target, join(manager.paths.profile, 'node_modules/deepseek-ai-cordis'), process.platform === 'win32' ? 'junction' : 'dir')
    await manager.applyRelease()
    expect(lstatSync(join(manager.paths.profile, 'node_modules/deepseek-ai-cordis'), { throwIfNoEntry: false })).toBeUndefined()
    expect(readFileSync(join(target, 'sentinel'), 'utf8')).toBe('retain')
  })

  it('preserves the manifest and patch when a retired plugin migration cannot parse the patch', async () => {
    const { manager } = setup()
    await manager.applyRelease()
    const profile = manager.paths.profile
    const path = join(profile, 'package.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as { dependencies: Record<string, string> }
    manifest.dependencies.dshmarket = '1.66.8'
    const originalManifest = JSON.stringify(manifest)
    writeFileSync(path, originalManifest)
    const patch = '- id: dsh-market\n  config: [broken\n'
    writeFileSync(join(profile, 'cordis.patch.yml'), patch)
    await expect(manager.applyRelease()).rejects.toThrow()
    expect(readFileSync(path, 'utf8')).toBe(originalManifest)
    expect(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')).toBe(patch)
    expect(readdirSync(profile).some(name => name.startsWith('cordis.patch.yml.bak-community-'))).toBe(false)
  })

  it('preserves installed packages, profile state, and the lockfile when preparing a launch', async () => {
    const { manager } = setup()
    await manager.applyRelease()
    seedPlugin(manager)
    const profile = manager.paths.profile
    const name = '@deepseek-ai/dsh-web-app'
    const path = join(profile, 'node_modules', name)
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
    const manifestPath = join(profile, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies: Record<string, string> }
    manifest.dependencies[name] = '1.0.0'
    writeFileSync(manifestPath, JSON.stringify(manifest))
    writeFileSync(join(profile, 'desktop-runtime-state.json'), JSON.stringify({ links: [] }))
    writeFileSync(join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
    const files = [
      'package.json',
      'pnpm-workspace.yaml',
      'desktop-runtime-state.json',
      'pnpm-lock.yaml',
      `node_modules/${name}/package.json`,
      'node_modules/plugin/package.json',
      'node_modules/plugin/bundle.yml',
    ]
    const before = files.map(file => readFileSync(join(profile, file), 'utf8'))

    await expect(manager.applyRelease()).resolves.toBeUndefined()

    expect(files.map(file => readFileSync(join(profile, file), 'utf8'))).toEqual(before)
    expect(lstatSync(path).isDirectory()).toBe(true)
    expect(lstatSync(join(profile, 'node_modules/plugin')).isDirectory()).toBe(true)
  })
  it('reports a declared bundled plugin the profile never materialized', async () => {
    const { manager } = setup()
    await manager.applyRelease()
    const manifestPath = join(manager.paths.profile, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies: Record<string, string> }
    manifest.dependencies['dsh-community'] = 'file:./desktop-packages/dsh-community-0.2.1-alpha.1.tgz'
    writeFileSync(manifestPath, JSON.stringify(manifest))

    expect(missingBundledPlugins(manager.paths.profile)).toEqual(['dsh-community'])

    mkdirSync(join(manager.paths.profile, 'node_modules/dsh-community'), { recursive: true })
    expect(missingBundledPlugins(manager.paths.profile)).toEqual([])
  })

  it('reuses plugin files without scanning manifests and can disable them', async () => {
    const { manager } = setup()
    await manager.applyRelease()
    seedPlugin(manager)
    const manifest = join(manager.paths.profile, 'node_modules/plugin/package.json')
    writeFileSync(manifest, '{broken')
    await expect(manager.applyRelease()).resolves.toBeUndefined()
    await manager.disableAllPlugins()
    await expect(manager.applyRelease()).resolves.toBeUndefined()
    expect(readFileSync(manifest, 'utf8')).toBe('{broken')
  })

  it('disables every third-party bundle without reading a broken plugin patch declaration', async () => {
    const { manager } = setup()
    await manager.applyRelease()
    seedPlugin(manager)
    const patch = join(manager.paths.profile, 'node_modules/plugin/bundle.yml')
    unlinkSync(patch)
    await manager.disableAllPlugins()
    expect((JSON.parse(readFileSync(join(manager.paths.profile, 'package.json'), 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }).dsh.profile.bundles).not.toContain('plugin')
    expect(existsSync(join(manager.paths.profile, 'node_modules/plugin/package.json'))).toBe(true)
    await expect(manager.applyRelease()).resolves.toBeUndefined()
  })

  it('disables plugins before runtime initialization and backs up the patch while preserving package files', async () => {
    const { manager } = setup()
    await manager.applyRelease()
    seedPlugin(manager)
    const patch = join(manager.paths.profile, 'cordis.patch.yml')
    writeFileSync(patch, ': broken')
    const uninitialized = new DesktopProjectManager(manager.paths, { ...manager.runtime, dsh: 'missing-runtime' })
    const backupPath = await uninitialized.disableAllPlugins()
    expect(existsSync(patch)).toBe(false)
    const backups = readdirSync(manager.paths.profile).filter(name => name.startsWith('cordis.patch.yml.bak-'))
    expect(backups).toHaveLength(1)
    expect(backupPath).toBe(join(manager.paths.profile, backups[0]!))
    expect(readFileSync(join(manager.paths.profile, backups[0]!), 'utf8')).toBe(': broken')
    expect(existsSync(join(manager.paths.profile, 'node_modules/plugin/package.json'))).toBe(true)
    const manifest = JSON.parse(readFileSync(join(manager.paths.profile, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    expect(manifest.dependencies.plugin).toBe('1.0.0')
    expect(manifest.dsh.profile.bundles).not.toContain('plugin')
    expect(manifest.dsh.profile.bundles).toContain('@deepseek-ai/dsh-web-app')
    await manager.applyRelease()
    expect(readFileSync(patch, 'utf8')).toContain('[]')
  })

  it('needs no runtime or package manifest when no plugins have been installed', async () => {
    const { manager } = setup()
    await expect(manager.disableAllPlugins()).resolves.toBeUndefined()
    expect(existsSync(join(manager.paths.profile, 'package.json'))).toBe(false)
    expect(existsSync(manager.paths.lock)).toBe(false)
  })

  it('reports invalid profile JSON without replacing it', async () => {
    const { manager } = setup()
    await manager.applyRelease()
    const path = join(manager.paths.profile, 'package.json')
    writeFileSync(path, '{broken')
    await expect(manager.disableAllPlugins()).rejects.toThrow()
    expect(readFileSync(path, 'utf8')).toBe('{broken')
    expect(existsSync(manager.paths.lock)).toBe(false)
  })

  it('initializes the same pnpm settings as a Web profile without a Desktop build allowlist', async () => {
    const { manager } = setup()
    await manager.applyRelease()
    expect(readFileSync(join(manager.paths.profile, 'pnpm-workspace.yaml'), 'utf8'))
      .toBe('packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  })

  it('opens a linked profile and migrates only the generated pnpm defaults', async () => {
    const { root, manager } = setup()
    const target = join(root, 'linked-profile')
    mkdirSync(target)
    mkdirSync(join(manager.paths.profile, '..'), { recursive: true })
    symlinkSync(target, manager.paths.profile, process.platform === 'win32' ? 'junction' : 'dir')
    await manager.applyRelease()
    const path = join(target, 'pnpm-workspace.yaml')
    const defaults = readFileSync(path, 'utf8')
    writeFileSync(path, `${defaults}strictDepBuilds: true\nallowBuilds:\n  node-pty: true\n  koffi: true\n  fs-ext: true\n  "@deepseek-ai/dsh-subprocess-local": true\n  '@google/genai': false\n  protobufjs: false\n  node-addon-require-builtin: false\n`)
    await manager.applyRelease()
    expect(readFileSync(path, 'utf8')).toBe(defaults)
    const custom = `${defaults}allowBuilds:\n  my-plugin: true\n`
    writeFileSync(path, custom)
    await manager.applyRelease()
    expect(readFileSync(path, 'utf8')).toBe(custom)
  })

  it('reports damaged application metadata as a reinstall failure', async () => {
    const { manager } = setup()
    writeFileSync(join(manager.runtime.dsh, 'desktop-runtime.json'), '{broken')
    await expect(manager.applyRelease()).rejects.toThrow()
  })

  it('preserves unknown files when initializing a profile', async () => {
    const { manager } = setup()
    mkdirSync(manager.paths.profile, { recursive: true })
    writeFileSync(join(manager.paths.profile, '.DS_Store'), 'metadata')
    writeFileSync(join(manager.paths.profile, 'user-file'), 'retain')
    await expect(manager.applyRelease()).resolves.toBeUndefined()
    expect(readFileSync(join(manager.paths.profile, '.DS_Store'), 'utf8')).toBe('metadata')
    expect(readFileSync(join(manager.paths.profile, 'user-file'), 'utf8')).toBe('retain')
    expect(readFileSync(join(manager.paths.profile, 'cordis.patch.yml'), 'utf8')).toContain('[]')
    expect(existsSync(join(manager.paths.profile, 'desktop-runtime-state.json'))).toBe(false)
  })

  it('initializes and restarts offline without executing pnpm', async () => {
    const { manager } = setup()
    await expect(manager.applyRelease()).resolves.toBeUndefined()
    await expect(manager.applyRelease()).resolves.toBeUndefined()
    expect(plugins(manager)).toEqual([])
    expect(JSON.parse(readFileSync(join(manager.paths.profile, 'package.json'), 'utf8'))).toMatchObject({ dependencies: {} })
  })

  it.skipIf(process.platform !== 'win32')('reuses the profile when the launch path changes only Windows letter casing', async () => {
    const { manager } = setup()
    await manager.applyRelease()
    const relaunched = new DesktopProjectManager(manager.paths, { ...manager.runtime, dsh: manager.runtime.dsh.toUpperCase() })
    await expect(relaunched.applyRelease()).resolves.toBeUndefined()
  })

  it.each(['changed', 'same-size', 'extra', 'missing'])('starts and reuses a profile without checking %s runtime bytes', async (operation) => {
    const { manager } = setup()
    if (operation === 'changed') writeFileSync(join(manager.runtime.dsh, 'package.json'), '{}')
    if (operation === 'same-size') writeFileSync(join(manager.runtime.dsh, 'package.json'), '{"type":"Module"}\n')
    if (operation === 'extra') writeFileSync(join(manager.runtime.dsh, 'extra'), '')
    if (operation === 'missing') unlinkSync(join(manager.runtime.dsh, 'package.json'))
    await expect(manager.applyRelease()).resolves.toBeUndefined()
    const relaunched = new DesktopProjectManager(manager.paths, manager.runtime)
    await expect(relaunched.applyRelease()).resolves.toBeUndefined()
    expect(existsSync(manager.paths.profile)).toBe(true)
  })

  it('keeps plugin files and patches through a compatible release and application relocation', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    seedPlugin(manager)
    writeFileSync(join(manager.paths.profile, 'cordis.patch.yml'), '[]\n')
    const nextRoot = join(root, 'relocated', 'dsh')
    runtimeFixture(nextRoot, '1.1.0')
    const next = new DesktopProjectManager(manager.paths, { ...manager.runtime, dsh: nextRoot })
    await expect(next.applyRelease()).resolves.toBeUndefined()
    expect(plugins(next)).toEqual(plugins(manager))
    expect(readFileSync(join(manager.paths.profile, 'cordis.patch.yml'), 'utf8')).toBe('[]\n')
    expect(readFileSync(join(manager.paths.profile, 'node_modules/plugin/bundle.yml'), 'utf8')).toBe('[]\n')
  })

  it('preserves plugin files without running pnpm when bundled Node changes', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    seedPlugin(manager)
    const dsh = join(root, 'new-node')
    runtimeFixture(dsh, '1.1.0', '24.18.0')
    const next = new DesktopProjectManager(manager.paths, { ...manager.runtime, dsh })
    await next.applyRelease()
    expect(plugins(next)).toEqual([{ name: 'plugin', version: '1.0.0', enabled: true }])
  })

  it('allows peer version mismatches to reach Host startup and remain available for recovery', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    seedPlugin(manager)
    const dsh = join(root, 'next-major')
    runtimeFixture(dsh, '2.0.0')
    const next = new DesktopProjectManager(manager.paths, { ...manager.runtime, dsh })
    await expect(next.applyRelease()).resolves.toBeUndefined()
    await next.disableAllPlugins()
    expect(plugins(next)).toEqual([{ name: 'plugin', version: '1.0.0', enabled: false }])
  })
})

describe.each(['applyRelease', 'disableAllPlugins'] as const)('desktop profile lock during %s', (operation) => {
  it('preserves a live owner lock and leaves the profile untouched', async () => {
    const { manager } = setup()
    mkdirSync(manager.paths.profile, { recursive: true })
    const owner = `${String(process.pid)}\n`
    writeFileSync(manager.paths.lock, owner)
    await expect(manager[operation]()).rejects.toThrow('another profile operation is active')
    expect(readFileSync(manager.paths.lock, 'utf8')).toBe(owner)
    expect(readdirSync(manager.paths.profile)).toEqual(['lock'])
  })

  it('reclaims a stale owner lock and releases it after the operation', async () => {
    const { manager } = setup()
    mkdirSync(manager.paths.profile, { recursive: true })
    writeFileSync(manager.paths.lock, `${String(process.pid)}\n`)
    const probe = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('process absent'), { code: 'ESRCH' })
    })
    try {
      await expect(manager[operation]()).resolves.toBeUndefined()
      expect(probe).toHaveBeenCalledExactlyOnceWith(process.pid, 0)
      expect(existsSync(manager.paths.lock)).toBe(false)
    } finally {
      probe.mockRestore()
    }
  })

  it.each(['invalid', '0', '-1', '9007199254740992'])('preserves a lock with invalid owner %s', async (owner) => {
    const { manager } = setup()
    mkdirSync(manager.paths.profile, { recursive: true })
    writeFileSync(manager.paths.lock, owner)
    await expect(manager[operation]()).rejects.toThrow('another profile operation is active')
    expect(readFileSync(manager.paths.lock, 'utf8')).toBe(owner)
  })

  it('rejects a directory at the lock path', async () => {
    const { manager } = setup()
    mkdirSync(manager.paths.lock, { recursive: true })
    await expect(manager[operation]()).rejects.toThrow('profile lock is not a regular file')
    expect(lstatSync(manager.paths.lock).isDirectory()).toBe(true)
  })

  it('rejects a linked lock without touching its target', async () => {
    const { root, manager } = setup()
    mkdirSync(manager.paths.profile, { recursive: true })
    const target = join(root, 'lock-target')
    mkdirSync(target)
    writeFileSync(join(target, 'sentinel'), 'retain')
    symlinkSync(target, manager.paths.lock, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      await expect(manager[operation]()).rejects.toThrow('profile lock is not a regular file')
      expect(lstatSync(manager.paths.lock).isSymbolicLink()).toBe(true)
      expect(readFileSync(join(target, 'sentinel'), 'utf8')).toBe('retain')
    } finally {
      unlinkSync(manager.paths.lock)
    }
  })
})

describe('desktop link-backend projections', () => {
  it('removes .dsh-module-fallback projections when preparing a launch', async () => {
    const { manager } = setup()
    await manager.applyRelease()
    const profile = manager.paths.profile
    const target = join(profile, 'node_modules', 'my-bundle', 'node_modules', 'bridge')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'package.json'), JSON.stringify({ name: 'bridge', version: '1.0.0' }))
    const owned = join(profile, '.dsh-module-fallback', 'node_modules', 'bridge')
    mkdirSync(dirname(owned), { recursive: true })
    symlinkSync(target, owned, process.platform === 'win32' ? 'junction' : 'dir')
    symlinkSync(owned, join(profile, 'node_modules', 'bridge'), process.platform === 'win32' ? 'junction' : 'dir')

    await manager.applyRelease()

    expect(existsSync(join(profile, '.dsh-module-fallback'))).toBe(false)
    expect(lstatSync(join(profile, 'node_modules', 'bridge'), { throwIfNoEntry: false })).toBeUndefined()
    expect(existsSync(join(target, 'package.json'))).toBe(true)
  })
})
