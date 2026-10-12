/** Compile the production protocol-uninstall macro; execution requires an isolated ordinary Windows SID. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'

if (process.platform !== 'win32') throw new Error('The native protocol fixture requires Windows')
const { values } = parseArgs({ options: {
  output: { type: 'string' }, 'compile-only': { type: 'boolean', default: false }, sid: { type: 'string' },
} })
if (!values['compile-only'] && !values.sid) throw new Error('Supply the isolated ordinary Windows SID or use --compile-only')
const appRoot = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const { getMakeNsisPath, getNsisPluginsPath } = require('app-builder-lib/out/toolsets/windows.js')
const { NsisScriptGenerator } = require('app-builder-lib/out/targets/nsis/nsisScriptGenerator.js')
const templates = join(dirname(require.resolve('app-builder-lib/package.json')), 'templates/nsis')
const output = values.output ? resolve(values.output) : await mkdtemp(join(appRoot, '.desktop-build/protocol-tests-'))
await mkdir(output, { recursive: true })
const executable = join(output, 'protocol-fixture.exe')
const script = join(output, 'protocol-fixture.nsi')
const helper = join(appRoot, '.desktop-build/targets/win-x64/installer-ui/window-frame.dll')
const compiler = await getMakeNsisPath()
const pluginPath = await getNsisPluginsPath()
const header = new NsisScriptGenerator()
header.addPluginDir('x86-unicode', join(pluginPath, 'x86-unicode'))
header.include(join(templates, 'include/StdUtils.nsh'))
header.flags(['updated'])
await writeFile(script, `Unicode true
RequestExecutionLevel user
Name "DSH Protocol Fixture"
OutFile "${executable}"
InstallDir "$LOCALAPPDATA\\DSHProtocolFixture"
SilentInstall silent
SilentUnInstall silent
!include "LogicLib.nsh"
${header.build()}
!define BUILD_UNINSTALLER
!define PRODUCT_FILENAME "DSH Protocol Fixture"
!define APP_EXECUTABLE_FILENAME "DeepSeek Harness.exe"
!define DSH_UPDATER_CACHE_NAME "dsh-protocol-fixture-updater"
!include "${join(appRoot, 'scripts/installer.nsh')}"
!include "${join(appRoot, 'installer/uninstall.nsh')}"
Section "Install"
  SetShellVarContext current
  SetRegView 64
  CreateDirectory "$INSTDIR"
  WriteUninstaller "$INSTDIR\\uninstall-fixture.exe"
SectionEnd
Section "Uninstall"
  SetShellVarContext current
  SetRegView 64
  InitPluginsDir
  File "/oname=$PLUGINSDIR\\window-frame.dll" "${helper}"
  !insertmacro customUnInstall
  FileOpen $0 "$INSTDIR\\fixture-completed.txt" w
  FileWrite $0 "completed"
  FileClose $0
SectionEnd
`)
const execute = promisify(execFile)
const result = await execute(compiler.path, ['/INPUTCHARSET', 'UTF8', '/V2', script], {
  windowsHide: true, env: { ...process.env, ...compiler.env }, maxBuffer: 4 * 1024 * 1024,
})
await writeFile(join(output, 'compile.log'), result.stdout + result.stderr)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const record = async path => ({ path, bytes: (await stat(path)).size, sha256: hash(await readFile(path)) })
const report = { passed: true, compiledAt: new Date().toISOString(), compiler: compiler.path,
  scope: 'Compiles actual production customUnInstall and un.CleanProtocol with the pinned updated-flag implementation and native cleanup helper; compilation writes no Windows protocol or installation registration.',
  source: await Promise.all([join(appRoot, 'installer/uninstall.nsh'), join(appRoot, 'scripts/installer.nsh')].map(record)),
  fixture: await record(executable), helper: await record(helper), sourceScript: await record(script), executed: false }
if (!values['compile-only']) {
  const worker = join(appRoot, 'tests/windows-protocol-uninstall-smoke.ps1')
  const run = await execute('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', worker,
    '-Installer', executable, '-ExpectedSid', values.sid, '-OutputDirectory', output], { windowsHide: true })
  process.stdout.write(run.stdout)
  const qualification = JSON.parse((await readFile(join(output, 'protocol-qualification.json'), 'utf8')).replace(/^\uFEFF/u, ''))
  assert.equal(qualification.passed, true)
  report.executed = true
}
await writeFile(join(output, 'protocol-build.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report))
