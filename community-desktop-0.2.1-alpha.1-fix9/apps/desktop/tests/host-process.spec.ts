import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopHostFatalError, DesktopHostProcess, DesktopHostUncleanExitError, QUIT_INSPECTION_DEADLINE_MS } from '../src/host-process.ts'
import type { DesktopHostOutput } from '../src/host-process.ts'
import type { CommunityInstallLogChunk } from '../src/community-types.ts'

const roots: string[] = []
const hosts: DesktopHostProcess[] = []

const HTTP_HOST = `
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
const server = createServer((request, response) => {
  if (request.url === '/fatal') {
    process.send({ type: 'fatal', message: 'plugin unavailable' })
    response.end('reported')
    return
  }
  if (request.url === '/crash') {
    response.end('exiting', () => {
      process.stderr.write('plugin crashed', () => process.exit(7))
    })
    return
  }
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({runtime: process.argv[2], profile: process.argv[3], cwd: process.cwd(), nodePath: process.env.NODE_PATH, registry: process.env.NPM_CONFIG_REGISTRY, nodeOptions: process.env.NODE_OPTIONS, runAsNode: process.env.ELECTRON_RUN_AS_NODE, internals: process.execArgv.includes('--expose-internals')}))
})
server.listen(0, '127.0.0.1', () => {
  process.send({ type: 'ready', url: 'http://127.0.0.1:' + server.address().port + '/?token=fixture' })
})
process.on('message', message => {
  if (message.type === 'update-tasks') {
    process.send({ type: 'update-tasks', requestId: message.requestId, active: message.action === 'lock' })
    return
  }
  if (message.type === 'quit-inspection') {
    // Ids divisible by three never answer; the others report scheduled work for odd ids.
    if (message.requestId % 3 === 0) return
    process.send({ type: 'quit-inspection', requestId: message.requestId, activeTasks: false, scheduledTasks: message.requestId % 2 === 1 })
    return
  }
  if (message.type !== 'shutdown') return
  server.close(() => {
    writeFileSync(join(process.argv[3], 'stopped'), '')
    process.send({ type: 'shutdown-complete' }, () => process.disconnect())
  })
  server.closeAllConnections()
})
`

function projectWithHost(source = HTTP_HOST): string {
  const project = mkdtempSync(join(tmpdir(), 'dsh-desktop-host-test-'))
  roots.push(project)
  const packageRoot = join(project, 'node_modules', '@deepseek-ai', 'dsh-desktop-host')
  mkdirSync(join(packageRoot, 'lib'), { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), '{"name":"@deepseek-ai/dsh-desktop-host","type":"module"}\n')
  writeFileSync(join(packageRoot, 'lib', 'index.js'), source)
  return project
}

function hostProcess(
  runtime: string, profile = runtime, onFailure?: (error: Error) => void, environment = process.env,
): DesktopHostProcess {
  const host = new DesktopHostProcess(process.execPath, runtime, profile, undefined, environment, onFailure)
  hosts.push(host)
  return host
}

afterEach(async () => {
  await Promise.all(hosts.splice(0).map(host => host.stop()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('desktop host process', () => {
  it('rejects an oversized install-log frame before calling main', async () => {
    const runtime = projectWithHost("process.send({ type: 'install-log', chunk: { jobId: 'run', argv: [], cwd: 'fixture', stream: 'stdout', text: 'x'.repeat(65_537) } })")
    const receiver = vi.fn()
    const host = new DesktopHostProcess(process.execPath, runtime, runtime, undefined, process.env,
      undefined, undefined, undefined, {}, receiver)
    hosts.push(host)
    await expect(host.start()).rejects.toThrow('invalid IPC event')
    expect(receiver).not.toHaveBeenCalled()
  })

  it.each([
    "requestId: 'x'.repeat(129)", "jobId: 'x'.repeat(129)", "cwd: 'x'.repeat(32_769)",
    "argv: Array(257).fill('x')", "argv: ['x'.repeat(4097)]",
  ])('rejects excessive install-log metadata: %s', async (metadata) => {
    const runtime = projectWithHost(`process.send({ type: 'install-log', chunk: { jobId: 'run', argv: [], cwd: 'fixture', stream: 'stdout', text: '', ${metadata} } })`)
    const receiver = vi.fn()
    const host = new DesktopHostProcess(process.execPath, runtime, runtime, undefined, process.env,
      undefined, undefined, undefined, {}, receiver)
    hosts.push(host)
    await expect(host.start()).rejects.toThrow('invalid IPC event')
    expect(receiver).not.toHaveBeenCalled()
  })

  it('receives native task output on IPC and decodes split UTF8 Host streams through EOF', async () => {
    const source = HTTP_HOST.replace("if (request.url === '/fatal')", `if (request.url === '/logs') {
      process.send({ type: 'install-log', chunk: { requestId: 'owned-task', jobId: 'pnpm-run', argv: ['pnpm', 'add', 'fixture'],
        cwd: process.cwd(), stream: 'stdout', text: 'native output\\n', exitCode: 0 } })
      const stdout = Buffer.from('安装完成尾'), stderr = Buffer.from('错误尾')
      process.stdout.write(stdout.subarray(0, 1)); process.stderr.write(stderr.subarray(0, 2))
      setTimeout(() => { process.stdout.write(stdout.subarray(1)); process.stderr.write(stderr.subarray(2)); response.end('logged') }, 25)
      return
    }
    if (request.url === '/fatal')`)
    const runtime = projectWithHost(source)
    const logs: CommunityInstallLogChunk[] = [], output: DesktopHostOutput[] = []
    const host = new DesktopHostProcess(process.execPath, runtime, runtime, undefined, process.env,
      undefined, undefined, undefined, {}, chunk => logs.push(chunk), chunk => output.push(chunk))
    hosts.push(host)
    const { url } = await host.start()
    await fetch(new URL('/logs', url))
    await expect.poll(() => logs.length).toBe(1)
    await host.stop(true)
    expect(logs[0]).toMatchObject({ requestId: 'owned-task', jobId: 'pnpm-run', text: 'native output\n', exitCode: 0 })
    expect(output.filter(chunk => chunk.stream === 'stdout').map(chunk => chunk.text).join('')).toBe('安装完成尾\n')
    expect(output.filter(chunk => chunk.stream === 'stderr').map(chunk => chunk.text).join('')).toBe('错误尾\n')
  })

  it('contains log callback failures without rejecting Host startup or control requests', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const runtime = projectWithHost(HTTP_HOST.replace("server.listen(0, '127.0.0.1', () => {", `server.listen(0, '127.0.0.1', () => {
        process.send({ type: 'install-log', chunk: { requestId: 'task', jobId: 'run', argv: [], cwd: process.cwd(), stream: 'stdout', text: '' } })
        process.stderr.write('startup fixture\\n')`))
      const host = new DesktopHostProcess(process.execPath, runtime, runtime, undefined, process.env,
        undefined, undefined, undefined, {}, () => { throw new Error('log receiver refused') }, () => { throw new Error('output receiver refused') })
      hosts.push(host)
      await host.start()
      await expect(host.updateTasks('inspect')).resolves.toBe(false)
      await host.stop(true)
      expect(consoleError).toHaveBeenCalledWith('Desktop installation log callback failed')
      expect(consoleError).toHaveBeenCalledWith('Desktop Host output callback failed')
    } finally { consoleError.mockRestore() }
  })

  it('rejects malformed install-log wire messages before dispatching them to main', async () => {
    const runtime = projectWithHost("process.send({ type: 'install-log', chunk: { jobId: 'run', argv: [1], cwd: 'fixture', stream: 'stdout', text: '' } })")
    const receiver = vi.fn()
    const host = new DesktopHostProcess(process.execPath, runtime, runtime, undefined, process.env,
      undefined, undefined, undefined, {}, receiver)
    hosts.push(host)
    await expect(host.start()).rejects.toThrow('invalid IPC event')
    expect(receiver).not.toHaveBeenCalled()
  })
  it('correlates task inspections and admission changes over private IPC', async () => {
    const host = hostProcess(projectWithHost())
    await expect(host.updateTasks('inspect')).rejects.toThrow('Host is unavailable')
    await host.start()
    expect(await Promise.all([host.updateTasks('inspect'), host.updateTasks('lock'), host.updateTasks('unlock')]))
      .toEqual([false, true, false])
    await host.stop(true)
    await expect(host.updateTasks('inspect')).rejects.toThrow('Host is unavailable')
  })

  it('correlates quit inspections with task requests and fails an unanswered one at its own deadline', async () => {
    const host = hostProcess(projectWithHost())
    await expect(host.inspectQuit()).rejects.toThrow('desktop quit: Host is unavailable')
    await host.start()
    // Request ids 1 and 2: the fixture answers by id parity, so both control kinds share one id space.
    expect(await Promise.all([host.inspectQuit(), host.updateTasks('inspect')]))
      .toEqual([{ activeTasks: false, scheduledTasks: true }, false])
    const started = Date.now()
    await expect(host.inspectQuit()).rejects.toThrow('desktop quit: inspection timed out')
    expect(Date.now() - started).toBeGreaterThanOrEqual(QUIT_INSPECTION_DEADLINE_MS - 50)
    expect(await host.inspectQuit()).toEqual({ activeTasks: false, scheduledTasks: false })
  }, 15_000)

  it.each([
    'process.exit(17)',
    'process.exit(0)',
  ])('refuses installation when exit lacks successful teardown acknowledgement: %s', async (exit) => {
    const host = hostProcess(projectWithHost(`
      process.send({ type: 'ready', url: 'http://127.0.0.1:3080/' })
      process.on('message', message => {
        if (message.type === 'shutdown') process.stderr.write('token=fixture-secret', () => { ${exit} })
      })
    `))
    await host.start()
    const error = await host.stop(true).then(() => undefined, (error: unknown) => error)
    expect(error).toBeInstanceOf(DesktopHostUncleanExitError)
    expect(String(error)).toContain('shutdown acknowledged false')
    expect(String(error)).toContain('graceful deadline exceeded false')
    expect(String(error)).not.toContain('fixture-secret')
    await expect(host.stop()).resolves.toBeUndefined()
  })

  it('returns the Web authentication URL and waits for graceful shutdown', async () => {
    const runtime = projectWithHost()
    const failure = vi.fn()
    const host = hostProcess(runtime, runtime, failure)
    const ready = await host.start()
    expect(new URL(ready.url).searchParams.get('token')).toBe('fixture')
    expect(await host.start()).toEqual(ready)
    expect((await fetch(ready.url)).status).toBe(200)
    await host.stop()
    expect(existsSync(join(runtime, 'stopped'))).toBe(true)
    await expect(fetch(ready.url)).rejects.toThrow()
    expect(failure).not.toHaveBeenCalled()
  })

  it('passes external dependencies and package-manager paths to the Host', async () => {
    const runtime = projectWithHost(HTTP_HOST.replace('runtime: process.argv[2]',
      'pnpm: process.argv[5], nodeBin: process.argv[6], primaryRuntime: process.argv[4], runtime: process.argv[2]'))
    const primaryRuntime = join(runtime, 'external-primary-runtime')
    const host = new DesktopHostProcess(process.execPath, runtime, runtime, undefined, process.env,
      undefined, primaryRuntime, { pnpm: join(runtime, 'pnpm.mjs'), nodeBin: join(runtime, 'bin') })
    hosts.push(host)
    const { url } = await host.start()
    expect(await (await fetch(url)).json()).toMatchObject({ primaryRuntime, pnpm: join(runtime, 'pnpm.mjs'), nodeBin: join(runtime, 'bin') })
  })

  it('reports a fatal event after readiness once', async () => {
    const runtime = projectWithHost()
    const failure = vi.fn()
    const host = hostProcess(runtime, runtime, failure)
    const { url } = await host.start()
    await fetch(new URL('/fatal', url))
    await expect.poll(() => failure.mock.calls.length).toBe(1)
    await host.stop()
    expect(failure).toHaveBeenCalledTimes(1)
    expect(failure).toHaveBeenCalledWith(new Error('plugin unavailable'))
  })

  it('reports a child crash after readiness with its stderr diagnostic', async () => {
    const runtime = projectWithHost()
    const failure = vi.fn()
    const host = hostProcess(runtime, runtime, failure)
    const { url } = await host.start()
    await fetch(new URL('/crash', url))
    await expect.poll(() => failure.mock.calls.length).toBe(1)
    expect(failure).toHaveBeenCalledWith(new Error('dsh desktop host exited with 7: plugin crashed'))
  })

  it('retains only recent diagnostics from a noisy child', async () => {
    const runtime = projectWithHost('process.stderr.write(\'discarded-prefix\' + \'x\'.repeat(70_000) + \'recent-failure\', () => { process.exitCode = 7; process.disconnect() })')
    const failure = await hostProcess(runtime).start().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    const message = (failure as Error).message
    expect(message).not.toContain('discarded-prefix')
    expect(message.endsWith('recent-failure')).toBe(true)
    expect(message.length).toBeLessThan(66_000)
  })

  it('settles teardown when the executable cannot be spawned', async () => {
    const runtime = projectWithHost()
    const host = new DesktopHostProcess(join(runtime, 'missing-node'), runtime, runtime)
    hosts.push(host)
    await expect(host.start()).rejects.toThrow()
    await host.stop()
  })

  it('loads the resource entry with a separate profile and inherits runtime and package-manager configuration', async () => {
    const runtime = projectWithHost()
    const profile = mkdtempSync(join(tmpdir(), 'desktop-external-profile-'))
    roots.push(profile)
    const host = hostProcess(runtime, profile, undefined, {
      ...process.env, NODE_OPTIONS: '--no-warnings', NODE_PATH: '/custom', NPM_CONFIG_REGISTRY: 'https://registry.example.test/',
    })
    const { url } = await host.start()
    const response = await fetch(url)
    expect(await response.json()).toEqual({ runtime, profile, cwd: realpathSync(profile), nodePath: '/custom', registry: 'https://registry.example.test/', nodeOptions: '--no-warnings', runAsNode: '1', internals: true })
  })

  it.each([
    ["process.send({ type: 'fatal', message: 'startup failed' }); process.disconnect()", 'startup failed'],
    ["process.send({ type: 'ready', url: 4 })", 'invalid IPC event'],
    ["process.send({ type: 'fatal', message: 'startup failed', diagnostic: 42 })", 'invalid IPC event'],
    ['process.exit(0)', 'host stopped'],
  ])('rejects startup when the child fails before readiness: %s', async (source, message) => {
    const host = hostProcess(projectWithHost(source))
    await expect(host.start()).rejects.toThrow(message)
  })

  it('keeps the Host\'s inspected error separate from the message it reports', async () => {
    const diagnostic = "Error: startup failed\\n    at boot (lib/index.js:3:9) {\\n  code: 'ENOENT',\\n  path: '/profile/cordis.yml'\\n}"
    const failures: Error[] = []
    const host = hostProcess(projectWithHost(
      `process.send({ type: 'fatal', message: 'startup failed', diagnostic: ${JSON.stringify(diagnostic)} }); process.disconnect()`,
    ), undefined, (error) => { failures.push(error) })
    await expect(host.start()).rejects.toThrow('startup failed')
    const [failure] = failures
    expect(failure).toBeInstanceOf(DesktopHostFatalError)
    expect((failure as DesktopHostFatalError).diagnostic).toBe(diagnostic)
    expect(Object.keys(failure!)).not.toContain('diagnostic')
  })
})

describe('desktop host methods', () => {
  // The child calls back into this process once for each native path action, so
  // each reply has to arrive correlated by id; the file it leaves behind is what
  // the test reads instead of routing the frames through a second channel.
  const CALLING_HOST = HTTP_HOST
    .replace("  if (request.url === '/fatal') {", `  if (request.url === '/native') {
    const answers = []
    const call = (id, method) => new Promise((resolve) => {
      process.on('message', function listener(message) {
        if (message.type !== 'desktop-rpc-response' || message.id !== id) return
        process.off('message', listener)
        resolve(message)
      })
      process.send({ type: 'desktop-rpc-request', id, method, payload: { path: 'C:\\\\work\\\\report.md' } })
    })
    Promise.all([call(1, 'native-reveal-path'), call(2, 'native-open-path')]).then(([reveal, open]) => {
      writeFileSync(join(process.argv[3], 'native-replies'), JSON.stringify({ reveal, open }))
      response.end('answered')
    }).catch((error) => { writeFileSync(join(process.argv[3], 'native-replies'), JSON.stringify({ error: String(error) })); response.end('answered') })
    return
  }
  if (request.url === '/fatal') {`)
    .replace("  if (request.url === '/fatal') {", `  if (request.url === '/unregistered') {
    new Promise((resolve) => {
      process.on('message', (message) => { if (message.type === 'desktop-rpc-response') resolve(message) })
      process.send({ type: 'desktop-rpc-request', id: 7, method: 'native-missing-path', payload: { path: 'x' } })
    }).then((reply) => { writeFileSync(join(process.argv[3], 'native-replies'), JSON.stringify(reply)); response.end('answered') })
    return
  }
  if (request.url === '/fatal') {`)

  const nativeReplies = (runtime: string): unknown => JSON.parse(readFileSync(join(runtime, 'native-replies'), 'utf8'))

  it('answers the Host child\'s native path calls over the private IPC channel', async () => {
    const runtime = projectWithHost(CALLING_HOST)
    const calls: { method: string; payload: unknown }[] = []
    const host = new DesktopHostProcess(process.execPath, runtime, runtime, undefined, process.env, undefined, undefined, undefined, {
      'native-reveal-path': async (payload) => { calls.push({ method: 'native-reveal-path', payload }); return { revealed: true } },
      'native-open-path': async (payload) => { calls.push({ method: 'native-open-path', payload }); return { opened: true } },
    })
    hosts.push(host)
    const { url } = await host.start()
    await fetch(new URL('/native', url))
    await expect.poll(() => existsSync(join(runtime, 'native-replies'))).toBe(true)
    expect(nativeReplies(runtime)).toEqual({
      reveal: { type: 'desktop-rpc-response', id: 1, ok: true, payload: { revealed: true } },
      open: { type: 'desktop-rpc-response', id: 2, ok: true, payload: { opened: true } },
    })
    expect(calls).toEqual([
      { method: 'native-reveal-path', payload: { path: 'C:\\work\\report.md' } },
      { method: 'native-open-path', payload: { path: 'C:\\work\\report.md' } },
    ])
  })

  it('refuses an unregistered Host method instead of leaving the caller waiting', async () => {
    const runtime = projectWithHost(CALLING_HOST)
    const failure = vi.fn()
    const host = new DesktopHostProcess(process.execPath, runtime, runtime, undefined, process.env, failure)
    hosts.push(host)
    const { url } = await host.start()
    await fetch(new URL('/unregistered', url))
    await expect.poll(() => existsSync(join(runtime, 'native-replies'))).toBe(true)
    expect(nativeReplies(runtime)).toEqual({
      type: 'desktop-rpc-response', id: 7, ok: false, error: 'desktop rpc: unknown method native-missing-path',
    })
    expect(failure).not.toHaveBeenCalled()
  })
})

