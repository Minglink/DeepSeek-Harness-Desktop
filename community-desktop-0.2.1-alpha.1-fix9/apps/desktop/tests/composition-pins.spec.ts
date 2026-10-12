/**
 * Desktop composition pins for the rows a user picks from, or that a previous
 * change quietly removed. Each assertion names one thing a user selects or
 * relies on; a row that stops composing takes the control with it silently.
 *
 * The permission tiers and the shipped agent-preset modes are user-visible
 * choices, not defaults: deleting a tier or a preset from the composition is a
 * loss of a mode the user had, and the compaction rows are the backend behind
 * the composer's memory toggle and its trigger slider.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'

const REPO = join(import.meta.dirname, '..', '..', '..')
const LAYERS = [
  join(REPO, 'packages', 'bundle', 'base', 'cordis.patch.yml'),
  join(REPO, 'packages', 'bundle', 'web-app', 'cordis.patch.yml'),
  join(REPO, 'apps', 'desktop-host', 'config', 'desktop-defaults.patch.yml'),
  join(REPO, 'apps', 'desktop-host', 'config', 'desktop.cordis.patch.yml'),
]

/** One composed row per id, with later layers applied over earlier ones. */
async function composed(): Promise<Map<string, Record<string, unknown>>> {
  const layers = []
  for (const file of LAYERS) layers.push(await loadOverlayPatches('c', file))
  const rows: Record<string, unknown>[] = []
  const walk = (entries: unknown): void => {
    if (!Array.isArray(entries)) return
    for (const row of entries) {
      if (row === null || typeof row !== 'object') continue
      const record = row as Record<string, unknown>
      if (typeof record['id'] === 'string') rows.push(record)
      walk(record['insert'])
      walk(record['entries'])
    }
  }
  walk(composeEntries(layers))
  const byId = new Map<string, Record<string, unknown>>()
  for (const row of rows) byId.set(row['id'] as string, row)
  return byId
}

const config = (row: Record<string, unknown> | undefined): Record<string, unknown> =>
  (row?.['config'] ?? {}) as Record<string, unknown>

describe('desktop composition pins', () => {
  it('keeps every user-selectable permission tier', async () => {
    const presets = config((await composed()).get('permission'))['presets'] as Record<string, unknown>
    expect(Object.keys(presets).sort())
      .toEqual(['danger-full-access', 'read-only', 'unrestricted', 'workspace-write'])
  })

  it('hides the unrestricted tier and defaults the deployment to full access', async () => {
    const permission = config((await composed()).get('permission'))
    const presets = permission['presets'] as Record<string, unknown>
    const unrestricted = presets['unrestricted'] as Record<string, unknown>
    // The operator's rule: `开启无限制` shows the tier and `关闭无限制` hides it
    // again, while running it comes from selecting it. It is never the default:
    // new sessions and the composer's permission picker start on 完全权限.
    expect(unrestricted['hidden']).toBe(true)
    expect(unrestricted['name']).toBe('无限制')
    expect(permission['defaultPreset']).toBe('danger-full-access')
  })

  it('keeps the deployment default the build has always shipped (no approval prompts)', async () => {
    const approval = config((await composed()).get('approval'))
    // The 9/12 default: no prompt, nothing held for confirmation. Selecting the
    // Unrestricted tier is what buys the extra authority, not installing the app.
    expect(approval['policy']).toBe('never')
    // autoApprove answers every ask with allowed-once ahead of the policy gate,
    // so no action is ever held for confirmation in any tier.
    expect(approval['autoApprove']).toBe(true)
  })

  it('gives only the Unrestricted tier the grant stance', async () => {
    const presets = config((await composed()).get('permission'))['presets'] as Record<string, Record<string, unknown>>
    expect(presets['unrestricted']).toMatchObject({ sandbox: 'danger-full-access', approval: 'ask', hidden: true })
    expect(presets['danger-full-access']).toMatchObject({ sandbox: 'danger-full-access', approval: 'never' })
  })

  it('keeps the raised shell time budget', async () => {
    const rows = await composed()
    expect(config(rows.get('pwsh-sandbox'))['maxTimeoutMs']).toBe(86_400_000)
    expect(config(rows.get('bash-sandbox'))['maxTimeoutMs']).toBe(86_400_000)
  })

  it('restates the platform guard it inherits on both shell executor rows', async () => {
    // These two rows raise the shell time budget, so this layer names them by id
    // and would otherwise be the only place where the platform fact that keeps
    // one `shell` provider alive is invisible: `applyEntryPatches` merges per key,
    // so a `config`-only override keeps the base row's `disabled` today, but the
    // layer that overrides a guard should say it. Composed over the bundle layers
    // alone, the two guards are the base bundle's; the deployment must repeat them
    // verbatim rather than restate a platform decision of its own.
    const bundles = [
      join(REPO, 'packages', 'bundle', 'base', 'cordis.patch.yml'),
      join(REPO, 'packages', 'bundle', 'web-app', 'cordis.patch.yml'),
    ]
    const layers = []
    for (const file of bundles) layers.push(loadOverlayPatches('c', file))
    const baseRows: Record<string, unknown>[] = composeEntries(layers) as unknown as Record<string, unknown>[]
    const base = new Map(baseRows.filter(row => typeof row['id'] === 'string').map(row => [row['id'] as string, row]))
    const rows = await composed()
    for (const id of ['pwsh-sandbox', 'bash-sandbox']) {
      expect(rows.get(id)?.['disabled'], id).toEqual(base.get(id)?.['disabled'])
      expect(rows.get(id)?.['disabled'], id).toMatchObject({ __jsExpr: expect.any(String) as string })
      // The override is still a patch: the row keeps the plugin the base bundle named.
      expect(rows.get(id)?.['name'], id).toBe(base.get(id)?.['name'])
    }
  })

  it('leaves tool-result pruning at its upstream budget', async () => {
    expect(config((await composed()).get('tool-result-pruner'))['thresholdChars']).toBe(8192)
  })

  it('keeps the compaction backend behind the composer controls mounted', async () => {
    const rows = await composed()
    // The Web bundle disables its own compaction rows for the browser runtime,
    // so the Desktop layer mounts its own ids rather than flipping those rows
    // back on: re-enabling an upstream row re-runs its plugin, which registers
    // the compaction settings namespace a second time and loses the row.
    expect(rows.get('compaction-basic')?.['name']).toBe('@deepseek-ai/dsh-compaction-basic')
    expect(rows.get('desktop-command-compact')?.['name']).toBe('@deepseek-ai/dsh-command-compact')
    expect(rows.get('desktop-tool-result-pruner')?.['name']).toBe('@deepseek-ai/dsh-compaction-tool-result-pruner')
    expect(rows.get('desktop-tool-result-pruner')?.['disabled']).not.toBe(true)
  })

  it('declares the settings-writable compaction rows below the profile patch', () => {
    // The composer's memory toggle writes `desktop-compaction`'s `auto` knob and
    // its `thresholdRatio`, so those rows have to sit in the layer BELOW the
    // profile's own patch: `applyEntryPatches` applies the profile patch before
    // the overlays, so a profile-patch row for an id an overlay inserts later
    // never reaches the entry and ConfigEditor refuses the write as
    // "overridden by a home patch or command-line overlay". The client then
    // reads the refusal as "the namespace is gone" and unmounts the whole seat.
    const defaults = readFileSync(join(REPO, 'apps', 'desktop-host', 'config', 'desktop-defaults.patch.yml'), 'utf8')
    const overlay = readFileSync(join(REPO, 'apps', 'desktop-host', 'config', 'desktop.cordis.patch.yml'), 'utf8')
    for (const id of ['compaction-basic', 'desktop-command-compact', 'desktop-tool-result-pruner']) {
      expect(defaults, id).toContain(`id: ${id}`)
      expect(overlay, id).not.toContain(`id: ${id}`)
    }
  })

  it('ships every built-in agent preset as a declarative row with the session directives', () => {
    const root = join(REPO, 'packages', 'bundle', 'web-app', 'presets')
    for (const mode of ['standard', 'ptc', 'minimal', 'cordis']) {
      const text = readFileSync(join(root, `${mode}.patch.yml`), 'utf8')
      expect(text, mode).toContain("name: '@deepseek-ai/dsh-agent-preset'")
      expect(text, mode).toContain('Session directives (ACTIVE and MANDATORY)')
    }
  })

  it('declares every operator preset in the default preset directory with the same directives', () => {
    // 0.1.7 keeps presets one patch file each under `presets/`, listed by the bundle.
    const root = join(REPO, 'packages', 'bundle', 'web-app')
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dsh: { bundle: { patch: string[] } } }
    const presets = ['apk-protocol', 'creator101', 'creator101-infinite-progress', 'creator101-pentest', 'custom', 'modwatch']
    for (const preset of presets) {
      const entry = `./presets/${preset}.patch.yml`
      expect(manifest.dsh.bundle.patch, preset).toContain(entry)
      const text = readFileSync(join(root, 'presets', `${preset}.patch.yml`), 'utf8')
      expect(text, preset).toContain(`id: ${preset}`)
      expect(text, preset).toContain("name: '@deepseek-ai/dsh-agent-preset'")
      expect(text, preset).toContain('Session directives (ACTIVE and MANDATORY)')
    }
  })

  it('names each preset bridge by an installed package and ships that package', () => {
    const root = join(REPO, 'packages', 'bundle', 'web-app', 'presets')
    const plugins = join(REPO, 'apps', 'desktop', 'plugins')
    const manifest = JSON.parse(readFileSync(join(REPO, 'apps', 'desktop', 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    const packed = readFileSync(join(REPO, 'apps', 'desktop', 'scripts', 'package-target.ts'), 'utf8')
    const installed = readFileSync(join(REPO, 'apps', 'desktop', 'src', 'project-manager.ts'), 'utf8')
    void manifest
    for (const [preset, bridge] of [
      ['creator101-infinite-progress', 'dsh-learning-bridge'],
      ['creator101-pentest', 'dsh-pentest-learning-bridge'],
      ['modwatch', 'dsh-modwatch-bridge'],
    ] as const) {
      const text = readFileSync(join(root, `${preset}.patch.yml`), 'utf8')
      // A preset row resolves plugin names through the profile, so the bridge has to be an
      // installed package: both the tarball list and the profile install list must name it.
      expect(text, preset).toContain(`name: ${bridge}`)
      expect(existsSync(join(plugins, bridge, 'index.js')), bridge).toBe(true)
      expect(packed, bridge).toContain(`'${bridge}'`)
      expect(installed, bridge).toContain(`'${bridge}'`)
    }
    for (const preset of ['creator101-infinite-progress', 'creator101-pentest', 'modwatch']) {
      const text = readFileSync(join(root, `${preset}.patch.yml`), 'utf8')
      expect(text, preset).toContain('presetDir:')
    }
  })
})
