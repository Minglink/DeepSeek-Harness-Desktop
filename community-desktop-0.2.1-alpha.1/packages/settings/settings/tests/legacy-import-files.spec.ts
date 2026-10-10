/** Backup failures and concurrent edits never remove either legacy document. */
import * as fs from 'node:fs/promises'
import { constants, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import Settings from '../src/index.ts'
import { configurationFixture } from './configuration-fixture.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, copyFile: vi.fn(original.copyFile) }
})
afterEach(async () => {
  vi.restoreAllMocks()
  const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(fs.copyFile).mockReset().mockImplementation(original.copyFile)
})

it('leaves original settings and current overrides intact if the exclusive backup fails', async () => {
  const { ctx, home, profile, start } = await configurationFixture({ hmr: false })
  await ctx.fiber.dispose()
  const before = readFileSync(profile.patchPath, 'utf8')
  const legacy = JSON.stringify({ first: { count: 88 } })
  writeFileSync(join(home, 'settings.yaml'), legacy)
  const copy = vi.mocked(fs.copyFile).mockRejectedValueOnce(Object.assign(new Error('backup denied'), { code: 'EACCES' }))
  const writes = vi.spyOn(Settings.prototype, 'update')
  await start()
  await vi.waitFor(() => { expect(copy).toHaveBeenCalledOnce() })
  await expect(copy.mock.results[0]!.value).rejects.toThrow('backup denied')
  expect(copy.mock.calls[0]![2]).toBe(constants.COPYFILE_EXCL)
  expect(writes).not.toHaveBeenCalled()
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
  expect(readFileSync(join(home, 'settings.yaml'), 'utf8')).toBe(legacy)
  expect(existsSync(join(home, 'settings.yaml.imported'))).toBe(false)
})

it('does not overwrite an existing backup or repeat its import', async () => {
  const { ctx, home, profile, start } = await configurationFixture({ hmr: false })
  await ctx.fiber.dispose()
  const before = readFileSync(profile.patchPath, 'utf8')
  const legacy = JSON.stringify({ first: { count: 88 } })
  const backup = JSON.stringify({ first: { count: 77 } })
  writeFileSync(join(home, 'settings.yaml'), legacy)
  writeFileSync(join(home, 'settings.yaml.imported'), backup)
  const writes = vi.spyOn(Settings.prototype, 'update')
  const restored = await start()
  expect(vi.mocked(fs.copyFile)).not.toHaveBeenCalled()
  expect(writes).not.toHaveBeenCalled()
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
  expect(readFileSync(join(home, 'settings.yaml'), 'utf8')).toBe(legacy)
  expect(readFileSync(join(home, 'settings.yaml.imported'), 'utf8')).toBe(backup)
  expect(restored.settings.describe().find(row => row.ns === 'first')!.value.count).toBe(2)
})

it('preserves a concurrent edit to the original file while importing the immutable backup', async () => {
  const { ctx, home, start } = await configurationFixture({ hmr: false })
  await ctx.fiber.dispose()
  const source = join(home, 'settings.yaml')
  const legacy = JSON.stringify({ first: { count: 88 } })
  const concurrent = JSON.stringify({ first: { count: 99 }, added: { text: 'concurrent' } })
  writeFileSync(source, legacy)
  const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(fs.copyFile).mockImplementationOnce(async (from, to, mode) => {
    await original.copyFile(from, to, mode)
    writeFileSync(source, concurrent)
  })
  const restored = await start()
  await vi.waitFor(() => { expect(restored.settings.describe().find(row => row.ns === 'first')!.value.count).toBe(88) })
  expect(readFileSync(source, 'utf8')).toBe(concurrent)
  expect(readFileSync(`${source}.imported`, 'utf8')).toBe(legacy)
})

it('refuses a backup created between its existence check and exclusive copy', async () => {
  const { ctx, home, profile, start } = await configurationFixture({ hmr: false })
  await ctx.fiber.dispose()
  const before = readFileSync(profile.patchPath, 'utf8')
  const source = join(home, 'settings.yaml')
  const legacy = JSON.stringify({ first: { count: 88 } })
  const concurrentBackup = JSON.stringify({ first: { count: 77 } })
  writeFileSync(source, legacy)
  const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const copy = vi.mocked(fs.copyFile).mockImplementationOnce(async (from, to, mode) => {
    writeFileSync(`${source}.imported`, concurrentBackup)
    await original.copyFile(from, to, mode)
  })
  const writes = vi.spyOn(Settings.prototype, 'update')
  await start()
  await vi.waitFor(() => { expect(copy).toHaveBeenCalledOnce() })
  await expect(copy.mock.results[0]!.value).rejects.toMatchObject({ code: 'EEXIST' })
  expect(writes).not.toHaveBeenCalled()
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
  expect(readFileSync(source, 'utf8')).toBe(legacy)
  expect(readFileSync(`${source}.imported`, 'utf8')).toBe(concurrentBackup)
})
