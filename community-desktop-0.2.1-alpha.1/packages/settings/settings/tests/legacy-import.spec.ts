/** Legacy imports preserve current profile choices through the real Loader and configuration editor. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import z from '@deepseek-ai/schemastery'
import Settings, { SettingsConflictError } from '../src/index.ts'
import { configurationFixture } from './configuration-fixture.ts'

afterEach(() => { vi.restoreAllMocks() })

const schema = z.object({
  ordinary: z.string(), enabled: z.boolean().default(true).volatile(), count: z.number().default(9).volatile(),
  text: z.string().default('base').volatile(), nullable: z.any().required(false).volatile(),
  nested: z.object({ legacy: z.string().required(false), user: z.string().required(false) }).default({}).volatile(),
  secret: z.string().required(false).role('secret').volatile(),
})

it('keeps false, zero, null, empty strings and empty objects while importing absent properties', async () => {
  const { ctx, home, profile, start } = await configurationFixture({ schema, hmr: false })
  await ctx.fiber.dispose()
  writeFileSync(profile.patchPath, JSON.stringify([{ id: 'first', config: { ordinary: 'fixed', enabled: false, count: 0, text: '', nullable: null, nested: {} } }]))
  const legacy = JSON.stringify({ first: { enabled: true, count: 88, text: 'old', nullable: 'old', nested: { legacy: 'old' }, secret: 'legacy-secret' } })
  writeFileSync(join(home, 'settings.yaml'), legacy)
  const restored = await start()
  await vi.waitFor(() => { expect(restored.settings.describe().find(row => row.ns === 'first')!.value).toEqual({ enabled: false, count: 0, text: '', nullable: null, nested: {}, secret: 'legacy-secret' }) })
  expect(readFileSync(join(home, 'settings.yaml.imported'), 'utf8')).toBe(legacy)
  expect(existsSync(join(home, 'settings.yaml'))).toBe(true)
  expect(readFileSync(join(home, 'settings.yaml'), 'utf8')).toBe(legacy)
  expect(JSON.stringify(restored.settings.describe({ redactSecrets: true }))).not.toContain('legacy-secret')
})

it('does not fill an explicit nested object or resurrect an unset value on restart', async () => {
  const { ctx, home, profile, start } = await configurationFixture({ schema, hmr: false })
  await ctx.fiber.dispose()
  writeFileSync(profile.patchPath, JSON.stringify([{ id: 'first', config: { ordinary: 'fixed', nested: { user: 'current' } } }]))
  writeFileSync(join(home, 'settings.yaml'), JSON.stringify({ first: { nested: { legacy: 'old' }, count: 33 } }))
  const restored = await start()
  await vi.waitFor(() => { expect(restored.settings.describe().find(row => row.ns === 'first')!.value).toMatchObject({ nested: { user: 'current' }, count: 33 }) })
  expect(restored.settings.describe().find(row => row.ns === 'first')!.value).not.toHaveProperty('nested.legacy')
  await restored.settings.mutate('first', [{ op: 'unset', path: ['count'] }], restored.settings.describe().find(row => row.ns === 'first')!.revision)
  const backup = readFileSync(join(home, 'settings.yaml.imported'), 'utf8')
  await restored.fiber.dispose()
  const again = await start()
  expect(again.settings.describe().find(row => row.ns === 'first')!.value).toMatchObject({ count: 9, nested: { user: 'current' } })
  expect(readFileSync(join(home, 'settings.yaml.imported'), 'utf8')).toBe(backup)
})

it('refreshes the revision and excludes a property added by a concurrent profile edit', async () => {
  const { ctx, home, profile, start } = await configurationFixture({ schema, hmr: false })
  await ctx.fiber.dispose()
  writeFileSync(join(home, 'settings.yaml'), JSON.stringify({ first: { count: 88, text: 'legacy' } }))
  // oxlint-disable-next-line typescript/unbound-method -- The test delegates with the original Settings instance via .call.
  const original = Settings.prototype.update
  const calls = vi.spyOn(Settings.prototype, 'update')
  let changed = false
  calls.mockImplementation(async function (ns, patch, revision) {
    if (ns === 'first' && !changed) {
      changed = true
      writeFileSync(profile.patchPath, JSON.stringify([{ id: 'first', config: { ordinary: 'fixed', count: 0 } }]))
    }
    await original.call(this, ns, patch, revision)
  })
  const restored = await start()
  await vi.waitFor(() => { expect(restored.settings.describe().find(row => row.ns === 'first')!.value).toMatchObject({ count: 0, text: 'legacy' }) })
  expect(calls.mock.calls.filter(([ns]) => ns === 'first')).toHaveLength(2)
  expect(calls.mock.calls[1]![1]).toEqual({ text: 'legacy' })
  expect(calls.mock.calls[1]![2]).toBeGreaterThan(calls.mock.calls[0]![2]!)
})

it('bounds conflicts without persisting stale legacy values', async () => {
  const { ctx, home, profile, start } = await configurationFixture({ schema, hmr: false })
  await ctx.fiber.dispose()
  const before = readFileSync(profile.patchPath, 'utf8')
  const legacy = JSON.stringify({ first: { count: 88 } })
  writeFileSync(join(home, 'settings.yaml'), legacy)
  // oxlint-disable-next-line typescript/unbound-method -- The test delegates with the original Settings instance via .call.
  const original = Settings.prototype.update
  const calls = vi.spyOn(Settings.prototype, 'update')
  calls.mockImplementation(async function (ns, patch, revision) {
    if (ns === 'first') throw new SettingsConflictError(ns, revision!, revision! + 1)
    await original.call(this, ns, patch, revision)
  })
  const restored = await start()
  await vi.waitFor(() => { expect(calls.mock.calls.filter(([ns]) => ns === 'first')).toHaveLength(3) })
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
  expect(readFileSync(join(home, 'settings.yaml.imported'), 'utf8')).toBe(legacy)
  expect(restored.settings.describe().find(row => row.ns === 'first')!.value).toMatchObject({ count: 9 })
})

it('retains invalid sections and current profile bytes without applying their valid siblings', async () => {
  const { ctx, home, profile, start } = await configurationFixture({ schema, hmr: false })
  await ctx.fiber.dispose()
  const before = readFileSync(profile.patchPath, 'utf8')
  const legacy = JSON.stringify({ first: { count: 'invalid', text: 'legacy' }, missing: { text: 'absent' } })
  writeFileSync(join(home, 'settings.yaml'), legacy)
  const writes = vi.spyOn(Settings.prototype, 'update')
  const restored = await start()
  await vi.waitFor(() => { expect(writes.mock.calls).toHaveLength(1) })
  await expect(writes.mock.results[0]!.value).rejects.toThrow()
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
  expect(readFileSync(join(home, 'settings.yaml.imported'), 'utf8')).toBe(legacy)
  expect(restored.settings.describe().find(row => row.ns === 'first')!.value).toMatchObject({ count: 9, text: 'base' })
})
