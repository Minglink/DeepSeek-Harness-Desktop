/** The pinned builder template keeps its registration flow around staged directory replacement. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { directoryCommonInstallerHeader, directoryInstallerExits, directoryInstallSection, directoryUninstaller, installWindowsDirectoryInstaller } from '../scripts/windows-directory-installer.mjs'

const require = createRequire(import.meta.url)
const section = readFileSync(join(dirname(require.resolve('app-builder-lib/package.json')),
  'templates/nsis/installSection.nsh'), 'utf8')

it('defines the literal cache folder before unchanged shared-header includes', () => {
  const original = '!include "production-installer.nsh"\n!define SENTINEL "unchanged"\n'
  expect(directoryCommonInstallerHeader(original, '@deepseek-aidsh-desktop-updater')).toBe(
    '!define DSH_UPDATER_CACHE_NAME "@deepseek-aidsh-desktop-updater"\n' + original,
  )
  for (const unsafe of ['', '$LOCALAPPDATA', '${OTHER}', 'a"b', 'a\nb', '../cache', 'a\\b']) {
    expect(() => directoryCommonInstallerHeader(original, unsafe)).toThrow('literal folder name')
  }
})

it('delegates common-header arguments and receiver before prefixing the original result', async () => {
  require('app-builder-lib')
  interface CommonHeaderReceiver { packager: { appInfo: { updaterCacheDirName: string } } }
  interface DirectoryTargetPrototype {
    computeCommonInstallerScriptHeader: (this: CommonHeaderReceiver, ...args: unknown[]) => Promise<string>
    computeFinalScript: unknown
  }
  const { NsisTarget } = require('app-builder-lib/out/targets/nsis/NsisTarget.js') as {
    NsisTarget: { prototype: DirectoryTargetPrototype }
  }
  const prototype = NsisTarget.prototype
  const originalCommon = prototype.computeCommonInstallerScriptHeader
  const originalFinal = prototype.computeFinalScript
  const marker = Symbol.for('@deepseek-ai/dsh-desktop/directory-installer')
  const receiver = { packager: { appInfo: { updaterCacheDirName: '@deepseek-aidsh-desktop-updater' } } }
  const args = [{ token: 'same-object' }, 17]
  let observedArgs: unknown[] = []
  try {
    prototype.computeCommonInstallerScriptHeader = async function (...received: unknown[]) {
      expect(this).toBe(receiver)
      observedArgs = received
      return '!include "production-installer.nsh"\n'
    }
    installWindowsDirectoryInstaller()
    const output = await prototype.computeCommonInstallerScriptHeader.apply(receiver, args)
    expect(observedArgs[0]).toBe(args[0])
    expect(observedArgs).toEqual(args)
    expect(output).toBe('!define DSH_UPDATER_CACHE_NAME "@deepseek-aidsh-desktop-updater"\n!include "production-installer.nsh"\n')
  }
  finally {
    prototype.computeCommonInstallerScriptHeader = originalCommon
    prototype.computeFinalScript = originalFinal
    Reflect.deleteProperty(prototype, marker)
  }
}, 30_000)

it('keeps data cleanup out of the upstream template while retaining application removal and registration cleanup', () => {
  const source = readFileSync(join(dirname(require.resolve('app-builder-lib/package.json')), 'templates/nsis/uninstaller.nsh'), 'utf8')
  const adapted = directoryUninstaller(source)
  expect(adapted).not.toContain('--delete-app-data')
  expect(adapted).not.toContain('RMDir /r "$APPDATA')
  expect(adapted).toContain('!insertmacro customUnInstall')
  expect(adapted).toContain('DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}"')
  expect(adapted).toContain('DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY_2}"')
  expect(directoryUninstaller(source.replaceAll('\n', '\r\n'))).toBe(adapted)
  expect(adapted).toContain('RMDir /r "\\\\?\\$INSTDIR"')
  expect(() => directoryUninstaller(source.replace('  Var /GLOBAL isDeleteAppData\n', ''))).toThrow('template changed')
  expect(() => directoryUninstaller(source.replace('  DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}"', ''))).toThrow('template changed')
})

it.each(['allowOnlyOneInstallerInstance.nsh', 'installUtil.nsh'])('cleans staged files before %s exits', (helper) => {
  const source = readFileSync(join(dirname(require.resolve('app-builder-lib/package.json')), 'templates/nsis/include', helper), 'utf8')
  const exits = source.match(/^\s*Quit\s*$/gm) ?? []
  expect(exits.length).toBeGreaterThan(0)
  const adapted = directoryInstallerExits(source)
  expect(adapted.match(/Call dshCleanupDirectories/g)).toHaveLength(exits.length)
  expect(adapted).toContain('!ifndef BUILD_UNINSTALLER')
})

it('stages before stopping the application and promotes before registering the installation', () => {
  const result = directoryInstallSection(section)
  expect(result.indexOf('!insertmacro dshStageApplication')).toBeLessThan(result.indexOf('!insertmacro CHECK_APP_RUNNING'))
  expect(result.indexOf('Call dshPromoteDirectories')).toBeLessThan(result.indexOf('!insertmacro registryAddInstallInfo'))
  expect(result).toContain('!insertmacro addStartMenuLink $keepShortcuts')
  expect(result).toContain('!insertmacro addDesktopLink $keepShortcuts')
  expect(result).toContain('!insertmacro handleUninstallResult HKEY_CURRENT_USER')
  expect(result).not.toContain('!insertmacro installApplicationFiles')
  expect(result).not.toContain('File /oname=uninstallerIcon.ico')
})

it.each(['!include installer.nsh', '!insertmacro setLinkVars', '!insertmacro installApplicationFiles'])(
  'rejects a missing or duplicate upstream insertion point: %s', (point) => {
    expect(() => directoryInstallSection(section.replace(point, ''))).toThrow('Desktop NSIS template changed')
    expect(() => directoryInstallSection(`${section}\n${point}`)).toThrow('Desktop NSIS template changed')
  },
)
