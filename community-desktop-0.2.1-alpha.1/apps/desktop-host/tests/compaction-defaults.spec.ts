/** Real first-party composition, Loader, compaction, and settings; no DCP code is imported. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context, FiberState } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { composeEntries, initProfile, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import BasicCompaction from '@deepseek-ai/dsh-compaction-basic'
import Llm from '@deepseek-ai/dsh-llm'
import Sessions from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { ConfigEditor } from '@deepseek-ai/dsh-config-editor'
import { SettingsForms } from '@deepseek-ai/dsh-settings'
import { afterEach, describe, expect, it } from 'vitest'

const exactDcp = '@aiwayds/dsh-dcp'
const defaultsPath = new URL('../config/desktop-defaults.patch.yml', import.meta.url)
let root: Context | undefined
let home: string | undefined

afterEach(async () => {
  await root?.fiber.dispose()
  root = undefined
  if (home !== undefined) await rm(home, { recursive: true, force: true })
  home = undefined
})

async function mounted(bundles: readonly string[], override?: boolean): Promise<Context> {
  home = await mkdtemp(join(tmpdir(), 'dsh-compaction-default-'))
  initProfile(home, [])
  const defaults = loadOverlayPatches('desktop-test', fileURLToPath(defaultsPath))
    .flatMap(patch => patch.insert ?? []).filter(row => row.id === 'desktop-compaction')
  expect(defaults).toHaveLength(1)
  const rows = composeEntries([
    [{ insert: [{ id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' }] }],
    // The bundle disables its intended predecessor before deployment defaults insert the fallback.
    bundles.includes(exactDcp) ? [{ id: 'compaction-basic', disabled: true }, { id: 'desktop-compaction', disabled: true }] : [],
    [{ insert: defaults }],
    [{ id: 'desktop-compaction', ...(override === undefined ? {} : { disabled: override }), config: { auto: false, thresholdRatio: 0.9 } }],
  ])
  const fallback = rows.find(row => row.id === 'desktop-compaction')!
  expect(fallback.name).toBe('@deepseek-ai/dsh-compaction-basic')
  expect(fallback.config).toEqual({ auto: false, thresholdRatio: 0.9 })
  root = new Context()
  root.baseUrl = pathToFileURL(home).href + '/'
  root.provide('profileContext', {
    name: 'desktop', dir: home, patchPath: join(home, 'cordis.patch.yml'), installAnchor: join(home, 'package.json'),
    home, cwd: home, startedBundles: [...bundles], defaultsFiles: [fileURLToPath(defaultsPath)], overlays: [], telemetryDisabledEnv: 'true',
  })
  await root.plugin(Loader)
  await root.plugin(ConfigEditor)
  await root.plugin(SettingsForms)
  await root.plugin(Llm)
  await root.plugin(Sessions)
  await root.plugin(SessionProjections)
  await root.plugin(TokenMeter)
  root.loader.builtins.basic = BasicCompaction
  root.loader.builtins.include = Include
  const rootConfig = join(home, 'cordis.yml')
  await writeFile(rootConfig, JSON.stringify([{ ...fallback, name: 'cordis:basic' }]))
  await root.loader.create({ id: 'include', name: 'cordis:include', config: { path: pathToFileURL(rootConfig).href } })
  await root.loader.await()
  return root
}

describe('Desktop compaction fallback deployment default', () => {
  it.each([
    { bundles: [], override: undefined, disabled: false },
    { bundles: [exactDcp], override: undefined, disabled: true },
    { bundles: ['@other/dsh-dcp'], override: undefined, disabled: false },
    { bundles: ['@aiwayds/dsh-dcp-extra'], override: undefined, disabled: false },
    { bundles: [exactDcp], override: false, disabled: false },
    { bundles: [], override: true, disabled: true },
  ])('uses exact launch bundles $bundles and respects override $override', async ({ bundles, override, disabled }) => {
    const ctx = await mounted(bundles, override)
    const entry = ctx.configEditor.entries().find(row => row.options.id === 'desktop-compaction')!
    expect(entry.disabled).toBe(disabled)
    if (disabled) {
      expect(entry.fiber).toBeUndefined()
      expect(ctx.get('compaction', true)).toBeUndefined()
      expect(ctx.settings.describe().find(section => section.ns === 'desktop-compaction')).toBeUndefined()
    } else {
      expect(entry.fiber?.state).toBe(FiberState.ACTIVE)
      expect(ctx.get('compaction', true)).toBeInstanceOf(BasicCompaction)
      const settings = ctx.settings.describe().find(section => section.ns === 'desktop-compaction')!
      expect(settings.value).toEqual({ auto: false, thresholdRatio: 0.9 })
    }
    expect(entry.options.config).toEqual({ auto: false, thresholdRatio: 0.9 })
  })

  it('retains the launch snapshot during a plain Loader reload instead of claiming live bundle selection', async () => {
    const ctx = await mounted([exactDcp])
    await ctx.loader.resolve('include').fiber!.restart()
    await ctx.loader.await()
    expect(ctx.configEditor.entries().find(row => row.options.id === 'desktop-compaction')?.disabled).toBe(true)
    expect(ctx.profileContext.startedBundles).toEqual([exactDcp])
    expect(ctx.get('compaction', true)).toBeUndefined()
  })
})
