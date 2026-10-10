/** Private profile fixtures verify promotion and recovery through real filesystem operations and owned lifecycle hooks. */
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CommunityProfileTransaction, CommunityTransactionError, communityTrialEnvironment, type CommunityTransactionOptions } from '../src/community-transaction.ts'
import type { CommunityTaskId } from '../src/community-types.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const prepared = { spec: 'fixture-candidate.tgz', packageName: '@example/test', version: '1.2.3', bundle: '@example/test' }
const task = { id: randomUUID() as CommunityTaskId, plugin: { id: 'fixture', name: 'Fixture', version: '1.2.3' } }
const originalFiles: Record<string, string> = {
  'package.json': JSON.stringify({ dependencies: { 'previous-plugin': '1.0.0' } }),
  'pnpm-lock.yaml': 'old lockfile\n', 'pnpm-workspace.yaml': 'old workspace\n', 'cordis.patch.yml': '- insert: []\n',
  'node_modules/previous-plugin/index.js': 'old dependency bytes\n',
  '.env': 'PRIVATE_KEY=fixture-env-secret\n', '.credentials.yaml': 'fixture: local-secret\n', 'desktop-config.json': '{"apiKey":"fixture-config-secret"}\n',
}

async function tree(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) await visit(join(directory, entry.name), path)
      else if (entry.isFile()) files[path] = await readFile(join(directory, entry.name), 'utf8')
      else throw new Error('Fixture tree contains an unexpected link')
    }
  }
  await visit(root, '')
  return files
}

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  await mkdir(root, { recursive: true })
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
}

async function fixture(overrides: Partial<CommunityTransactionOptions> = {}): Promise<{
  root: string; profile: string; directory: string; options: CommunityTransactionOptions; transaction: CommunityProfileTransaction; events: string[]
}> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-transaction-fixture-'))
  roots.push(root)
  const profile = join(root, 'desktop'), directory = join(root, 'journal'), events: string[] = []
  await writeTree(profile, originalFiles)
  await mkdir(directory)
  const options: CommunityTransactionOptions = {
    profile, directory,
    trial: async (candidate, home) => {
      events.push('trial')
      expect(await tree(home)).toEqual({})
      const trialFiles = await tree(candidate)
      expect(trialFiles).not.toHaveProperty('.env')
      expect(trialFiles).not.toHaveProperty('.credentials.yaml')
      expect(trialFiles).not.toHaveProperty('desktop-config.json')
      await writeTree(candidate, { 'package.json': JSON.stringify({ dependencies: { '@example/test': '1.2.3' } }),
        'node_modules/previous-plugin/index.js': 'new dependency bytes\n', 'node_modules/new-plugin/index.js': 'new plugin\n' })
    },
    pause: async recovering => { events.push(recovering ? 'pause-recovery' : 'pause') },
    resume: async () => { events.push('resume') },
    healthy: async () => { events.push('healthy') }, ...overrides,
  }
  return { root, profile, directory, options, transaction: new CommunityProfileTransaction(options), events }
}

function paths(root: string, id: string): { candidate: string; backup: string; home: string; rejected: string } {
  return { candidate: join(root, `.community-candidate-${id}`), backup: join(root, `.community-backup-${id}`),
    home: join(root, `.community-trial-${id}`), rejected: join(root, `.community-rejected-${id}`) }
}

async function journal(directory: string, id: string, phase: string, extra: object = {}): Promise<void> {
  await writeFile(join(directory, 'installation-v1.json'), JSON.stringify({ version: 1, id, taskId: task.id, plugin: task.plugin, phase, ...extra }))
}

describe('community profile transaction', () => {
  it('refuses AI adaptation for profile-copy metadata errors before any trial Host starts', async () => {
    let trialCalls = 0
    const data = await fixture({ trial: async () => { trialCalls++ } })
    const malformed = 'virtualStoreDir: [not a path]\n'
    await writeTree(data.profile, { 'node_modules/.modules.yaml': malformed })
    const error: unknown = await data.transaction.install(prepared, task, new AbortController().signal, () => {}).catch(error => error)
    expect(error).toBeInstanceOf(CommunityTransactionError)
    if (!(error instanceof CommunityTransactionError)) throw new Error('Expected a transaction failure')
    expect({ code: error.code, restored: error.restored, diagnostic: error.diagnostic, adaptationEligible: error.adaptationEligible }).toMatchInlineSnapshot(`
      {
        "adaptationEligible": false,
        "code": "trial-failed",
        "diagnostic": "Community profile pnpm virtualStoreDir must be a string",
        "restored": true,
      }
    `)
    expect(trialCalls).toBe(0)
    expect(await tree(data.profile)).toEqual({ ...originalFiles, 'node_modules/.modules.yaml': malformed })
    expect((await readdir(data.root)).filter(name => name.startsWith('.community-'))).toEqual([])
  })

  it('retains an unfinished trial journal and candidate when the trial child stop cannot be confirmed', async () => {
    const data = await fixture({ trial: async () => {
      throw new CommunityTransactionError('rollback-failed', false, 'community-trial stop-failed', false)
    } })
    await expect(data.transaction.install(prepared, task, new AbortController().signal, () => {})).rejects.toMatchObject({
      code: 'rollback-failed', restored: false, diagnostic: 'community-trial stop-failed', adaptationEligible: false,
    })
    const record = JSON.parse(await readFile(join(data.directory, 'installation-v1.json'), 'utf8'))
    expect(record.phase).toBe('trial')
    expect((await lstat(paths(data.root, record.id).candidate)).isDirectory()).toBe(true)
    expect((await lstat(paths(data.root, record.id).home)).isDirectory()).toBe(true)
    expect(await tree(data.profile)).toEqual(originalFiles)
    expect(data.events).toEqual([])
  })

  it('preserves whether adaptation can address a rejected trial while leaving every live file unchanged', async () => {
    const data = await fixture({ trial: async () => {
      throw new CommunityTransactionError('trial-failed', true, 'ERR_PNPM_UNEXPECTED_VIRTUAL_STORE', false)
    } })
    await expect(data.transaction.install(prepared, task, new AbortController().signal, () => {})).rejects.toMatchObject({
      code: 'trial-failed', restored: true, diagnostic: 'ERR_PNPM_UNEXPECTED_VIRTUAL_STORE', adaptationEligible: false,
    })
    expect(await tree(data.profile)).toEqual(originalFiles)
    expect((await readdir(data.root)).filter(name => name.startsWith('.community-'))).toEqual([])
  })

  it('keeps ordinary plugin trial failures eligible for adaptation', async () => {
    const data = await fixture({ trial: async () => { throw new Error('Plugin registration failed') } })
    await expect(data.transaction.install(prepared, task, new AbortController().signal, () => {})).rejects.toMatchObject({
      code: 'trial-failed', restored: true, adaptationEligible: true,
    })
    expect(await tree(data.profile)).toEqual(originalFiles)
  })

  it('restores original pnpm metadata bytes after activation failure and later rollback', async () => {
    const data = await fixture()
    const name = 'node_modules/.modules.yaml'
    const original = JSON.stringify({ virtualStoreDir: join(data.profile, 'node_modules', '.pnpm'),
      storeDir: join(data.root, 'external-store'), layoutVersion: 5, virtualStoreDirMaxLength: 60 }, null, 2) + '\n'
    await writeTree(data.profile, { [name]: original })
    data.options.trial = async (candidate) => {
      const candidateMetadata = JSON.parse(await readFile(join(candidate, name), 'utf8'))
      expect(candidateMetadata.virtualStoreDir).toBe(join(candidate, 'node_modules', '.pnpm'))
      expect(candidateMetadata.storeDir).toBe(join(data.root, 'external-store'))
      expect(await readFile(join(data.profile, name), 'utf8')).toBe(original)
    }
    data.options.healthy = async () => {
      expect(await readFile(join(data.profile, name), 'utf8')).toBe(original)
      throw new Error('Synthetic activation failure')
    }
    await expect(data.transaction.install(prepared, task, new AbortController().signal, () => {})).rejects.toMatchObject({ restored: true })
    expect(await tree(data.profile)).toEqual({ ...originalFiles, [name]: original })
    data.options.healthy = async () => {}
    await data.transaction.install(prepared, task, new AbortController().signal, () => {})
    expect(await data.transaction.rollbackLast()).toMatchObject({ taskId: task.id })
    expect(await tree(data.profile)).toEqual({ ...originalFiles, [name]: original })
  })

  it('promotes only a healthy candidate and preserves local credentials outside the trial', async () => {
    const { transaction, profile, directory, events } = await fixture()
    const phases: string[] = []
    await transaction.install(prepared, task, new AbortController().signal, phase => phases.push(phase))
    const files = await tree(profile)
    expect(files['node_modules/previous-plugin/index.js']).toBe('new dependency bytes\n')
    expect(files['node_modules/new-plugin/index.js']).toBe('new plugin\n')
    for (const name of ['.env', '.credentials.yaml', 'desktop-config.json']) expect(files[name]).toBe(originalFiles[name])
    expect(events).toEqual(['trial', 'pause', 'resume', 'healthy'])
    expect(phases).toEqual(['trial', 'activating'])
    expect(JSON.parse(await readFile(join(directory, 'installation-v1.json'), 'utf8')).phase).toBe('committed')
    expect(await transaction.recover()).toBeUndefined()
  })

  it('keeps an absolute dependency junction private to the trial, live profile, backup, and restored profile', async () => {
    const data = await fixture()
    const target = 'node_modules/.pnpm/current', linked = 'node_modules/test-link'
    const old = 'original linked dependency\n', adapted = 'candidate linked dependency\n'
    await writeTree(data.profile, { [`${target}/index.js`]: old })
    await symlink(join(data.profile, target), join(data.profile, linked), process.platform === 'win32' ? 'junction' : 'dir')
    data.options.trial = async candidate => {
      expect(await realpath(join(candidate, linked))).toBe(await realpath(join(candidate, target)))
      expect(await readFile(join(candidate, linked, 'index.js'), 'utf8')).toBe(old)
      await writeFile(join(candidate, linked, 'index.js'), adapted)
      expect(await readFile(join(data.profile, linked, 'index.js'), 'utf8')).toBe(old)
      expect(await realpath(join(data.profile, linked))).toBe(await realpath(join(data.profile, target)))
    }
    await expect(data.transaction.install(prepared, task, new AbortController().signal, () => {})).resolves.toBeUndefined()
    const saved = JSON.parse(await readFile(join(data.directory, 'installation-v1.json'), 'utf8'))
    const backup = paths(data.root, saved.id).backup
    expect(await realpath(join(data.profile, linked))).toBe(await realpath(join(data.profile, target)))
    expect(await readFile(join(data.profile, linked, 'index.js'), 'utf8')).toBe(adapted)
    expect(await realpath(join(backup, linked))).toBe(await realpath(join(backup, target)))
    expect(await readFile(join(backup, linked, 'index.js'), 'utf8')).toBe(old)
    expect(await data.transaction.rollbackLast()).toEqual({ taskId: task.id, plugin: task.plugin })
    expect(await realpath(join(data.profile, linked))).toBe(await realpath(join(data.profile, target)))
    expect(await readFile(join(data.profile, linked, 'index.js'), 'utf8')).toBe(old)
    expect((await readdir(data.root)).filter(name => name.startsWith('.community-'))).toEqual([])
  })

  it('leaves every old file and dependency byte untouched when the candidate trial fails', async () => {
    const { transaction, profile, root, events } = await fixture({ trial: async candidate => {
      await writeTree(candidate, { 'package.json': '{}', 'node_modules/previous-plugin/index.js': 'candidate mutation' })
      throw new Error('Candidate startup failed')
    } })
    await expect(transaction.install(prepared, task, new AbortController().signal, () => {})).rejects.toMatchObject({ code: 'trial-failed', restored: true })
    expect(await tree(profile)).toEqual(originalFiles)
    expect(events).toEqual([])
    expect((await readdir(root)).filter(name => name.startsWith('.community-'))).toEqual([])
  })

  it('restores the complete old profile after promotion fails its health check', async () => {
    const { transaction, profile, events } = await fixture({ healthy: async () => { throw new Error('New Host failed') } })
    const phases: string[] = []
    await expect(transaction.install(prepared, task, new AbortController().signal, phase => phases.push(phase)))
      .rejects.toMatchObject({ code: 'activation-failed', restored: true })
    expect(await tree(profile)).toEqual(originalFiles)
    expect(events).toEqual(['trial', 'pause', 'resume', 'pause-recovery', 'resume'])
    expect(phases).toEqual(['trial', 'activating', 'rolling-back'])
  })

  it('keeps the original profile and does not restart when the live Host refuses the installation pause', async () => {
    const data = await fixture({ pause: async () => { throw new Error('Live Host has an active task') } })
    const phases: string[] = []
    await expect(data.transaction.install(prepared, task, new AbortController().signal, phase => phases.push(phase)))
      .rejects.toMatchObject({ code: 'activation-failed', restored: true })
    expect(await tree(data.profile)).toEqual(originalFiles)
    expect(data.events).toEqual(['trial'])
    expect(phases).toEqual(['trial'])
    expect((await readdir(data.root)).filter(name => name.startsWith('.community-'))).toEqual([])
  })

  it('recovers cancellation after trial before any live profile replacement', async () => {
    const controller = new AbortController()
    const { transaction, profile, events } = await fixture({ trial: async () => { controller.abort() } })
    await expect(transaction.install(prepared, task, controller.signal, () => {})).rejects.toMatchObject({ code: 'cancelled', restored: true })
    expect(await tree(profile)).toEqual(originalFiles)
    expect(events).toEqual([])
  })

  it('recovers cancellation during health confirmation after promotion', async () => {
    const controller = new AbortController()
    const { transaction, profile } = await fixture({ healthy: async () => { controller.abort() } })
    await expect(transaction.install(prepared, task, controller.signal, () => {})).rejects.toMatchObject({ code: 'cancelled', restored: true })
    expect(await tree(profile)).toEqual(originalFiles)
  })

  it('stops a cancelled pending activation before restoring and restarting the old profile', async () => {
    const controller = new AbortController(), started = Promise.withResolvers<void>(), stopped = Promise.withResolvers<void>()
    const data = await fixture({ startupTimeoutMs: 1_000 })
    const pending = stopped.promise.then(() => {})
    let starts = 0
    data.options.resume = async () => {
      data.events.push('resume')
      if (++starts === 1) { started.resolve(); await pending }
    }
    data.options.pause = async recovering => {
      data.events.push(recovering ? 'pause-recovery' : 'pause')
      if (recovering) { stopped.resolve(); await pending }
    }
    const phases: string[] = []
    const settled = expect(data.transaction.install(prepared, task, controller.signal, phase => phases.push(phase)))
      .rejects.toMatchObject({ code: 'cancelled', restored: true })
    try {
      await started.promise
      controller.abort()
      await settled
    } finally { stopped.resolve(); await pending }
    expect(starts).toBe(2)
    expect(await tree(data.profile)).toEqual(originalFiles)
    expect(data.events).toEqual(['trial', 'pause', 'resume', 'pause-recovery', 'resume'])
    expect(phases).toEqual(['trial', 'activating', 'rolling-back'])
  })

  it('bounds a pending activation startup and restores the previous profile after its deadline', async () => {
    const stopped = Promise.withResolvers<void>(), pending = stopped.promise.then(() => {})
    const data = await fixture({ startupTimeoutMs: 20 })
    let starts = 0
    data.options.resume = async () => { data.events.push('resume'); if (++starts === 1) await pending }
    data.options.pause = async recovering => {
      data.events.push(recovering ? 'pause-recovery' : 'pause')
      if (recovering) { stopped.resolve(); await pending }
    }
    try {
      await expect(data.transaction.install(prepared, task, new AbortController().signal, () => {}))
        .rejects.toMatchObject({ code: 'activation-failed', restored: true })
    } finally { stopped.resolve(); await pending }
    expect(starts).toBe(2)
    expect(await tree(data.profile)).toEqual(originalFiles)
    expect(data.events).toEqual(['trial', 'pause', 'resume', 'pause-recovery', 'resume'])
  })

  it('stops a recovery restart that exceeds its own deadline and retains the journal for next startup', async () => {
    const stopped = Promise.withResolvers<void>(), pending = stopped.promise.then(() => {})
    const data = await fixture({ startupTimeoutMs: 20, healthy: async () => { throw new Error('New Host failed') } })
    let starts = 0, recoveryStops = 0
    data.options.resume = async () => { data.events.push('resume'); if (++starts === 2) await pending }
    data.options.pause = async recovering => {
      data.events.push(recovering ? 'pause-recovery' : 'pause')
      if (recovering && ++recoveryStops === 2) { stopped.resolve(); await pending }
    }
    try {
      await expect(data.transaction.install(prepared, task, new AbortController().signal, () => {}))
        .rejects.toMatchObject({ code: 'rollback-failed', restored: false })
    } finally { stopped.resolve(); await pending }
    expect(await tree(data.profile)).toEqual(originalFiles)
    expect(data.events).toEqual(['trial', 'pause', 'resume', 'pause-recovery', 'resume', 'pause-recovery'])
    const saved = JSON.parse(await readFile(join(data.directory, 'installation-v1.json'), 'utf8'))
    expect(saved.phase).toBe('restored')
    expect(await tree(paths(data.root, saved.id).rejected)).toHaveProperty('node_modules/new-plugin/index.js')
    expect(await data.transaction.recover()).toBeUndefined()
    expect((await readdir(data.root)).filter(name => name.startsWith('.community-'))).toEqual([])
    expect(await tree(data.profile)).toEqual(originalFiles)
  })

  it('refuses promotion if another profile writer changed its configuration during the trial', async () => {
    const data = await fixture()
    data.options.trial = async () => { await writeFile(join(data.profile, 'cordis.patch.yml'), 'user changed configuration\n') }
    await expect(data.transaction.install(prepared, task, new AbortController().signal, () => {})).rejects.toMatchObject({ code: 'profile-changed', restored: true })
    expect((await tree(data.profile))['cordis.patch.yml']).toBe('user changed configuration\n')
    expect(data.events).toEqual([])
  })

  it.each(['trial', 'before-old-rename', 'between-renames', 'after-promotion'])('restores interrupted %s state before normal startup', async stage => {
    const data = await fixture()
    const id = randomUUID(), files = paths(data.root, id)
    await writeTree(files.candidate, { 'package.json': '{"candidate":true}', 'partial.js': 'candidate' })
    await writeTree(files.home, { 'scratch.json': 'trial data' })
    if (stage === 'between-renames' || stage === 'after-promotion') await rename(data.profile, files.backup)
    if (stage === 'after-promotion') await rename(files.candidate, data.profile)
    await journal(data.directory, id, stage === 'trial' ? 'trial' : stage === 'after-promotion' ? 'activating' : 'swapping')
    expect(await data.transaction.recover()).toEqual({ taskId: task.id, plugin: task.plugin })
    expect(await tree(data.profile)).toEqual(originalFiles)
    expect((await readdir(data.root)).filter(name => name.startsWith('.community-'))).toEqual([])
    expect(JSON.parse(await readFile(join(data.directory, 'installation-v1.json'), 'utf8')).phase).toBe('restored')
  })

  it.each([
    '{invalid', JSON.stringify({ version: 2 }), JSON.stringify({ version: 1, id: '../outside', taskId: task.id, plugin: task.plugin, phase: 'swapping' }),
    JSON.stringify({ version: 1, id: randomUUID(), taskId: task.id, plugin: task.plugin, phase: 'unknown' }),
    JSON.stringify({ version: 1, id: randomUUID(), taskId: task.id, plugin: { name: 'missing id' }, phase: 'trial' }),
  ])('rejects a malformed journal without touching the live profile', async content => {
    const data = await fixture()
    await writeFile(join(data.directory, 'installation-v1.json'), content)
    await expect(data.transaction.recover()).rejects.toThrow()
    expect(await tree(data.profile)).toEqual(originalFiles)
    expect(await readFile(join(data.directory, 'installation-v1.json'), 'utf8')).toBe(content)
  })

  it('requires recovery of a stale unfinished journal before accepting another installation', async () => {
    const data = await fixture(), id = randomUUID()
    await journal(data.directory, id, 'trial')
    await expect(data.transaction.install(prepared, task, new AbortController().signal, () => {}))
      .rejects.toMatchObject({ code: 'recovery-required', restored: false })
    expect(await tree(data.profile)).toEqual(originalFiles)
    await data.transaction.recover()
    await data.transaction.install(prepared, task, new AbortController().signal, () => {})
    expect((await tree(data.profile))['node_modules/new-plugin/index.js']).toBe('new plugin\n')
  })

  it('serializes two transactions on their shared journal while the first trial owns its candidate', async () => {
    const data = await fixture()
    const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), entered: number[] = []
    let calls = 0
    const originalTrial = data.options.trial
    data.options.trial = async (...args) => {
      const number = ++calls
      entered.push(number)
      if (number === 1) { started.resolve(); await release.promise }
      await originalTrial(...args)
    }
    const first = data.transaction.install(prepared, task, new AbortController().signal, () => {})
    await started.promise
    const second = new CommunityProfileTransaction(data.options).install(prepared, { ...task, id: randomUUID() as CommunityTaskId }, new AbortController().signal, () => {})
    expect(entered).toEqual([1])
    release.resolve()
    await Promise.all([first, second])
    expect(entered).toEqual([1, 2])
    expect(JSON.parse(await readFile(join(data.directory, 'installation-v1.json'), 'utf8')).phase).toBe('committed')
    expect(await data.transaction.recover()).toBeUndefined()
  })

  it('refuses recursive cleanup of a link-shaped candidate and preserves its target', async () => {
    const data = await fixture(), id = randomUUID(), files = paths(data.root, id)
    const outside = join(data.root, 'outside')
    await writeTree(outside, { 'keep.txt': 'must remain' })
    await symlink(outside, files.candidate, process.platform === 'win32' ? 'junction' : 'dir')
    await journal(data.directory, id, 'committed')
    await expect(data.transaction.recover()).rejects.toThrow(/link/u)
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('must remain')
    expect((await lstat(files.candidate)).isSymbolicLink()).toBe(true)
    await unlink(files.candidate)
  })

  it('refuses a link-shaped recovery backup before replacing the live profile', async () => {
    const data = await fixture(), id = randomUUID(), files = paths(data.root, id)
    const outside = join(data.root, 'outside')
    await writeTree(outside, { 'keep.txt': 'must remain' })
    await symlink(outside, files.backup, process.platform === 'win32' ? 'junction' : 'dir')
    await journal(data.directory, id, 'activating')
    await expect(data.transaction.recover()).rejects.toMatchObject({ code: 'invalid-profile', restored: false })
    expect(await tree(data.profile)).toEqual(originalFiles)
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('must remain')
    expect((await lstat(files.backup)).isSymbolicLink()).toBe(true)
    await unlink(files.backup)
  })

  it('retains the old backup and unfinished journal when rejected Host teardown fails, allowing next-start recovery', async () => {
    const data = await fixture({ healthy: async () => { throw new Error('Promotion failed') },
      pause: async recovering => { if (recovering) throw new Error('Rejected Host teardown failed') } })
    await expect(data.transaction.install(prepared, task, new AbortController().signal, () => {})).rejects.toMatchObject({ code: 'rollback-failed', restored: false })
    const saved = JSON.parse(await readFile(join(data.directory, 'installation-v1.json'), 'utf8'))
    expect(saved.phase).toBe('activating')
    expect(await tree(paths(data.root, saved.id).backup)).toEqual(originalFiles)
    expect(await data.transaction.recover()).toEqual({ taskId: task.id, plugin: task.plugin })
    expect(await tree(data.profile)).toEqual(originalFiles)
  })

  it('reports failed recovery when both the live profile and backup are missing', async () => {
    const data = await fixture(), id = randomUUID()
    await rm(data.profile, { recursive: true })
    await journal(data.directory, id, 'swapping')
    await expect(data.transaction.recover()).rejects.toMatchObject({ code: 'rollback-failed', restored: false })
    expect(JSON.parse(await readFile(join(data.directory, 'installation-v1.json'), 'utf8')).phase).toBe('swapping')
  })

  it('automatically restores the last healthy promotion after a later Host failure and runs only once', async () => {
    const data = await fixture()
    await data.transaction.install(prepared, task, new AbortController().signal, () => {})
    data.events.splice(0)
    expect(await data.transaction.rollbackLast()).toEqual({ taskId: task.id, plugin: task.plugin })
    expect(await tree(data.profile)).toEqual(originalFiles)
    expect(data.events).toEqual(['pause-recovery', 'resume'])
    expect(JSON.parse(await readFile(join(data.directory, 'installation-v1.json'), 'utf8')).phase).toBe('restored')
    expect(await data.transaction.rollbackLast()).toBeUndefined()
    expect(data.events).toEqual(['pause-recovery', 'resume'])
  })

  it('skips an old Host recovery queued behind a newer healthy installation without pausing the new Host', async () => {
    const data = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    let generation = 0, checks = 0
    data.options.resume = async () => { generation++; data.events.push('resume') }
    await data.transaction.install(prepared, task, new AbortController().signal, () => {})
    const oldGeneration = generation, originalTrial = data.options.trial
    data.options.trial = async (...args) => {
      entered.resolve()
      await release.promise
      await originalTrial(...args)
      await writeFile(join(args[0], 'node_modules/new-plugin/index.js'), 'second healthy plugin\n')
    }
    data.events.splice(0)
    const second = data.transaction.install(prepared, { ...task, id: randomUUID() as CommunityTaskId }, new AbortController().signal, () => {})
    await entered.promise
    const rollback = data.transaction.rollbackLast(() => { checks++; return generation === oldGeneration })
    expect(checks).toBe(0)
    release.resolve()
    await second
    expect(await rollback).toBeUndefined()
    expect(checks).toBe(1)
    expect(generation).toBe(2)
    expect(data.events).toEqual(['trial', 'pause', 'resume', 'healthy'])
    expect(await readFile(join(data.profile, 'node_modules/new-plugin/index.js'), 'utf8')).toBe('second healthy plugin\n')
    expect(JSON.parse(await readFile(join(data.directory, 'installation-v1.json'), 'utf8')).phase).toBe('committed')
  })

  it('rechecks Host eligibility after pausing and preserves the promoted profile when eligibility changed', async () => {
    const data = await fixture()
    await data.transaction.install(prepared, task, new AbortController().signal, () => {})
    const promoted = await tree(data.profile)
    const saved = JSON.parse(await readFile(join(data.directory, 'installation-v1.json'), 'utf8'))
    let eligible = true, checks = 0
    data.events.splice(0)
    data.options.pause = async () => { data.events.push('pause-recovery'); eligible = false }
    expect(await data.transaction.rollbackLast(() => { checks++; return eligible })).toBeUndefined()
    expect(checks).toBe(2)
    expect(data.events).toEqual(['pause-recovery', 'resume'])
    expect(await tree(data.profile)).toEqual(promoted)
    expect(await tree(paths(data.root, saved.id).backup)).toEqual(originalFiles)
    expect(JSON.parse(await readFile(join(data.directory, 'installation-v1.json'), 'utf8')).phase).toBe('committed')
  })

  it('keeps newer user configuration when it no longer matches the last promoted fingerprint', async () => {
    const data = await fixture()
    await data.transaction.install(prepared, task, new AbortController().signal, () => {})
    await writeFile(join(data.profile, 'cordis.patch.yml'), 'newer user configuration\n')
    const changed = await tree(data.profile)
    data.events.splice(0)
    expect(await data.transaction.rollbackLast()).toBeUndefined()
    expect(await tree(data.profile)).toEqual(changed)
    expect(data.events).toEqual([])
  })

  it('skips automatic rollback when its retained backup has been removed', async () => {
    const data = await fixture()
    await data.transaction.install(prepared, task, new AbortController().signal, () => {})
    const saved = JSON.parse(await readFile(join(data.directory, 'installation-v1.json'), 'utf8'))
    await rm(paths(data.root, saved.id).backup, { recursive: true })
    data.events.splice(0)
    expect(await data.transaction.rollbackLast()).toBeUndefined()
    expect(data.events).toEqual([])
    expect((await tree(data.profile))['node_modules/new-plugin/index.js']).toBe('new plugin\n')
  })

  it.each(['.env', '.credentials.yaml', 'desktop-config.json', '.env.local', '.ENV.LOCAL'])('preserves a newer private %s file instead of reverting its secret during late recovery', async name => {
    const data = await fixture()
    await data.transaction.install(prepared, task, new AbortController().signal, () => {})
    await writeFile(join(data.profile, name), 'newer-private-value\n')
    data.events.splice(0)
    expect(await data.transaction.rollbackLast()).toBeUndefined()
    expect(await readFile(join(data.profile, name), 'utf8')).toBe('newer-private-value\n')
    expect(data.events).toEqual([])
  })

  it('excludes an uppercase Windows environment file from trial and restores its exact bytes on promotion', async () => {
    const data = await fixture()
    const name = '.ENV.LOCAL', bytes = 'PRIVATE_KEY=fixture-uppercase-secret\n'
    await writeFile(join(data.profile, name), bytes)
    const originalTrial = data.options.trial
    data.options.trial = async (...args) => {
      expect(await tree(args[0])).not.toHaveProperty(name)
      await originalTrial(...args)
    }
    await data.transaction.install(prepared, task, new AbortController().signal, () => {})
    expect(await readFile(join(data.profile, name), 'utf8')).toBe(bytes)
  })

  it('rechecks a shutdown-flushed user configuration before replacing the live profile', async () => {
    const data = await fixture()
    await data.transaction.install(prepared, task, new AbortController().signal, () => {})
    data.events.splice(0)
    data.options.pause = async () => { data.events.push('pause-recovery'); await writeFile(join(data.profile, 'cordis.patch.yml'), 'shutdown-flushed configuration\n') }
    expect(await data.transaction.rollbackLast()).toBeUndefined()
    expect(await readFile(join(data.profile, 'cordis.patch.yml'), 'utf8')).toBe('shutdown-flushed configuration\n')
    expect(data.events).toEqual(['pause-recovery', 'resume'])
    expect((await tree(data.profile))['node_modules/new-plugin/index.js']).toBe('new plugin\n')
  })

  it('retains the last committed recovery baseline when a later candidate trial fails', async () => {
    const data = await fixture()
    await data.transaction.install(prepared, task, new AbortController().signal, () => {})
    const first = JSON.parse(await readFile(join(data.directory, 'installation-v1.json'), 'utf8'))
    const promoted = await tree(data.profile)
    data.options.trial = async () => { throw new Error('Second candidate failure') }
    await expect(data.transaction.install(prepared, { ...task, id: randomUUID() as CommunityTaskId }, new AbortController().signal, () => {}))
      .rejects.toMatchObject({ code: 'trial-failed', restored: true })
    expect(await tree(data.profile)).toEqual(promoted)
    expect(JSON.parse(await readFile(join(data.directory, 'installation-v1.json'), 'utf8')).id).toBe(first.id)
    expect(await tree(paths(data.root, first.id).backup)).toEqual(originalFiles)
    expect(await data.transaction.rollbackLast()).toEqual({ taskId: task.id, plugin: task.plugin })
    expect(await tree(data.profile)).toEqual(originalFiles)
  })

  it('restores an interrupted second trial while retaining the previous committed rollback baseline', async () => {
    const data = await fixture()
    await data.transaction.install(prepared, task, new AbortController().signal, () => {})
    const first = JSON.parse(await readFile(join(data.directory, 'installation-v1.json'), 'utf8'))
    const promoted = await tree(data.profile)
    const id = randomUUID(), secondTask = randomUUID() as CommunityTaskId, pending = paths(data.root, id)
    await writeTree(pending.candidate, { 'package.json': '{"second":true}' })
    await journal(data.directory, id, 'trial', { taskId: secondTask, previous: {
      id: first.id, taskId: first.taskId, plugin: first.plugin, promotedFingerprint: first.promotedFingerprint,
    } })
    expect(await data.transaction.recover()).toEqual({ taskId: secondTask, plugin: task.plugin })
    expect(await tree(data.profile)).toEqual(promoted)
    expect(JSON.parse(await readFile(join(data.directory, 'installation-v1.json'), 'utf8')).id).toBe(first.id)
    expect(await tree(paths(data.root, first.id).backup)).toEqual(originalFiles)
    expect(await data.transaction.rollbackLast()).toEqual({ taskId: task.id, plugin: task.plugin })
    expect(await tree(data.profile)).toEqual(originalFiles)
  })

  it('drops credential variables and user settings from candidate process environment', () => {
    const environment = communityTrialEnvironment({ PATH: 'fixture-bin', USERPROFILE: 'fixture-home', DEEPSEEK_API_KEY: 'secret',
      api_token: 'token', SERVICE_PASSWORD: 'password', DSH_HOME: 'real-home', DSH_SETTINGS_FILE: 'real-settings', DSH_CLIENT_VERSION: 'test-version',
      NODE_OPTIONS: '--import dangerous', NPM_CONFIG_USERCONFIG: 'private-npmrc', HTTP_PROXY: 'http://proxy.local' }, 'trial-home')
    expect(environment).toMatchObject({ PATH: 'fixture-bin', DSH_HOME: 'trial-home', DSH_CLIENT_VERSION: 'test-version', HTTP_PROXY: 'http://proxy.local',
      NPM_CONFIG_USERCONFIG: join('trial-home', 'trial.npmrc'), NPM_CONFIG_IGNORE_SCRIPTS: 'true' })
    for (const key of ['DEEPSEEK_API_KEY', 'api_token', 'SERVICE_PASSWORD', 'DSH_SETTINGS_FILE', 'NODE_OPTIONS']) expect(environment[key]).toBeUndefined()
  })
})
