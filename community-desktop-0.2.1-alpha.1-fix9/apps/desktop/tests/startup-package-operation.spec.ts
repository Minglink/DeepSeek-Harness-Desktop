/** Real subprocesses prove live diagnostics and owned tree teardown before profile reuse. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { CommunityRuntimeLogStore } from '../src/community-runtime-log.ts'
import { desktopNodeEnvironment } from '../src/node-environment.ts'
import { DesktopStartupPackageError, resolveDesktopStartupInstallConfig, runDesktopStartupPackageOperation,
  type StartupPackageDiagnostic } from '../src/startup-package-operation.ts'

const roots: string[] = []
const stores: CommunityRuntimeLogStore[] = []
const runner = fileURLToPath(new URL('../../../packages/subprocess/subprocess-local/lib/runner.js', import.meta.url))
afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.flush()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture(source: string) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-startup-operation-')); roots.push(root)
  const entry = join(root, 'pnpm-fixture.mjs'); await writeFile(entry, source)
  const diagnostics: StartupPackageDiagnostic[] = []
  const store = new CommunityRuntimeLogStore(root, () => ['bare-startup-secret'], () => {})
  stores.push(store)
  const options = { executable: process.execPath, entry, args: [], cwd: root, runner,
    environment: desktopNodeEnvironment(process.execPath, undefined, process.env), config: { timeoutMs: 2_000 },
    log: (diagnostic: StartupPackageDiagnostic) => { diagnostics.push(diagnostic); store.append(diagnostic) } }
  return { root, options, diagnostics, store }
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

describe('startup package operation', () => {
  it('uses a deployment duration and rejects invalid budgets before spawning', async () => {
    expect(resolveDesktopStartupInstallConfig({})).toEqual({ timeoutMs: 300_000 })
    for (const value of ['0', '999', 'NaN', '1.5', '2147483648']) expect(() =>
      resolveDesktopStartupInstallConfig({ DSH_DESKTOP_STARTUP_INSTALL_TIMEOUT_MS: value })).toThrow('DSH_DESKTOP_STARTUP_INSTALL_TIMEOUT_MS')
    const { options, diagnostics } = await fixture('process.exit(99)')
    const signal = AbortSignal.abort()
    await expect(runDesktopStartupPackageOperation({ ...options, signal })).rejects.toMatchObject({ code: 'startup-install-aborted', quiescent: true })
    expect(diagnostics).toEqual([])
  })

  it('persists split lines while the child is still running, with redaction and a final unterminated line', async () => {
    const { root, options, store } = await fixture(`process.stdout.write('bare-start');
setTimeout(() => process.stdout.write('up-secret slow registry\\n'), 50);
setTimeout(() => { process.stderr.write('UND_ERR_SOCKET: original cause\\n'); process.stdout.write('final partial'); }, 300);
setTimeout(() => {}, 600);`)
    let observed: () => void = () => {}
    const live = new Promise<void>((resolveLive) => { observed = resolveLive })
    const operation = runDesktopStartupPackageOperation({ ...options, log: (diagnostic) => {
      options.log(diagnostic); if (diagnostic.text.includes('slow registry')) observed()
    } })
    await live; await store.flush()
    const during = await new CommunityRuntimeLogStore(root, () => [], () => {}).read()
    expect(during.entries.some(item => item.text.includes('[redacted] slow registry'))).toBe(true)
    expect(during.entries.some(item => item.text.includes('startup pnpm exit:'))).toBe(false)
    await operation; await store.flush()
    const disk = await readFile(join(root, 'runtime-log-v1.json'), 'utf8')
    expect(disk).not.toContain('bare-startup-secret')
    const history = await store.read()
    expect(history.entries.some(item => item.source === 'pnpm' && item.text === 'UND_ERR_SOCKET: original cause')).toBe(true)
    expect(history.entries.some(item => item.text === 'final partial')).toBe(true)
    expect(history.entries.at(-1)?.text).toContain('process tree quiet: true')
  })

  it('omits oversized lines in full and bounds the pending output queue without leaking credentials', async () => {
    const { options, store, diagnostics } = await fixture(`process.stdout.write('bare-startup-secret' + 'x'.repeat(300000) + '\\n');
for (let index = 0; index < 300; index++) process.stdout.write('bounded-' + index + 'y'.repeat(4096) + '\\n');`)
    await runDesktopStartupPackageOperation(options); await store.flush()
    const history = await store.read()
    expect(diagnostics.some(item => item.text === '[oversized diagnostic omitted]')).toBe(true)
    expect(JSON.stringify(history)).not.toContain('bare-startup-secret')
    expect(Buffer.byteLength(JSON.stringify(history))).toBeLessThanOrEqual(256 * 1024)
    expect(history.truncated).toBe(true)
    expect(history.entries.at(-1)?.text).toContain('startup pnpm exit: 0')
  })

  it('retains original nonzero output and reports a classified quiet failure', async () => {
    const { options, diagnostics } = await fixture("console.error('registry rejected: original 503'); process.exit(7)")
    await expect(runDesktopStartupPackageOperation(options)).rejects.toMatchObject({ code: 'startup-install-failed', quiescent: true })
    expect(diagnostics.some(item => item.text === 'registry rejected: original 503')).toBe(true)
    expect(diagnostics.at(-1)?.text).toContain('startup pnpm exit: 7')
  })

  it.each(['timeout', 'abort', 'exited parent'] as const)('waits for an owned grandchild to exit on %s', async (mode) => {
    const { root, options } = await fixture(`import { spawn } from 'node:child_process'; import { existsSync } from 'node:fs';
const grandchild = spawn(process.execPath, ['grandchild.mjs'], { stdio: 'ignore', detached: process.platform === 'win32', windowsHide: true });
console.log('grandchild=' + grandchild.pid);
${mode === 'abort' ? "const ready = setInterval(() => { if (existsSync('heartbeat')) { clearInterval(ready); console.log('grandchild-ready'); } }, 10);" : ''}
${mode === 'exited parent' ? 'process.exit(0);' : 'setInterval(() => {}, 1000);'}`)
    await writeFile(join(root, 'grandchild.mjs'), "import { writeFileSync } from 'node:fs'; setInterval(() => writeFileSync('heartbeat', Date.now().toString()), 50);")
    const controller = new AbortController()
    let grandchild: number | undefined
    const operation = runDesktopStartupPackageOperation({ ...options, config: { timeoutMs: 1_000 }, signal: controller.signal,
      log: (diagnostic) => {
        options.log(diagnostic)
        if (diagnostic.text.startsWith('grandchild=')) {
          grandchild = Number(diagnostic.text.slice('grandchild='.length))
        }
        if (mode === 'abort' && diagnostic.text === 'grandchild-ready') controller.abort()
      } })
    await expect(operation).rejects.toMatchObject({ code: mode === 'abort' ? 'startup-install-aborted' : 'startup-install-timeout', quiescent: true })
    expect(grandchild).toBeTypeOf('number')
    expect(alive(grandchild as number)).toBe(false)
    const heartbeat = await readFile(join(root, 'heartbeat'), 'utf8')
    await new Promise<void>((resolveWait) => { setTimeout(resolveWait, 100) })
    expect(await readFile(join(root, 'heartbeat'), 'utf8')).toBe(heartbeat)
  }, 15_000)

  it.runIf(process.platform === 'win32')('does not label an unconfirmed runner teardown as safe profile reuse', async () => {
    const { root, options } = await fixture('process.exit(0)')
    const brokenRunner = join(root, 'failed-runner.mjs')
    await writeFile(brokenRunner, 'process.exit(29)')
    let error: unknown
    try { await runDesktopStartupPackageOperation({ ...options, runner: brokenRunner }) } catch (cause) { error = cause }
    expect(error).toBeInstanceOf(DesktopStartupPackageError)
    expect(error).toMatchObject({ code: 'startup-install-cleanup-failed', quiescent: false })
  })
})
