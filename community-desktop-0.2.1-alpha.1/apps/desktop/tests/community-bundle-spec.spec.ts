/** Native spec fixtures inspect strings only and never read archives or run package operations. */
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseInstallSpec } from '../../../packages/boot/plugin-manager/src/install-spec.ts'
import { nativeCommunityBundleSpec } from '../src/community-bundle-spec.ts'
import { communityFailureSummary } from '../src/community-failure.ts'

function prepared(name = 'dsh-purge', spec = resolve(tmpdir(), '社区 artifacts', '插件 1.1.67.tgz')) {
  return { packageName: name, bundle: name, version: '1.1.67', spec }
}

describe('manifest-named native community tarball specs', () => {
  it.each(['dsh-purge', '@example/scoped-addon', '@example~scope/addon~name'])(
    'preserves verified %s identity and the exact absolute local artifact target', (name) => {
      const value = prepared(name), original = { ...value }, spec = nativeCommunityBundleSpec(value)
      expect(spec).toBe(`${name}@file:${value.spec.replace(/\\/gu, '/')}`)
      expect(parseInstallSpec(spec)).toEqual({ kind: 'registry', name, spec, range: `file:${value.spec.replace(/\\/gu, '/')}` })
      expect(value).toEqual(original)
      expect(spec.startsWith(`${name}@`)).toBe(true)
    })

  it.runIf(process.platform === 'win32')('handles a scoped package and Windows drive path with spaces and Unicode as one argument', () => {
    const value = prepared('@saya-ch/dsh-mobile', 'C:\\Users\\Administrator\\社区 插件\\artifact.tgz')
    const spec = nativeCommunityBundleSpec(value)
    expect(spec).toBe('@saya-ch/dsh-mobile@file:C:/Users/Administrator/社区 插件/artifact.tgz')
    expect(parseInstallSpec(spec)).toMatchObject({ name: '@saya-ch/dsh-mobile', range: 'file:C:/Users/Administrator/社区 插件/artifact.tgz' })
  })

  it.each(['', '--flag', '../escape', '@scope', 'name@other', 'BadName', 'bad name', 'a'.repeat(215)])(
    'rejects a non-verified package name %j with fixed non-adaptable infrastructure context', (name) => {
      let failure: unknown
      try { nativeCommunityBundleSpec(prepared(name)) } catch (error) { failure = error }
      expect(communityFailureSummary(failure)).toEqual({ code: 'trial-failed', cause: 'preparation', adaptationEligible: false })
    })

  it.each(['relative.tgz', 'file:/absolute/artifact.tgz', 'https://example.com/archive.tgz', '--ignore-scripts',
    resolve(tmpdir(), 'artifact.zip'), `${resolve(tmpdir(), 'artifact.tgz')}\n--flag`, `${resolve(tmpdir(), 'artifact')}\u0000.tgz`])(
    'rejects a non-local or malformed prepared artifact %j before native Host allocation', (spec) => {
      expect(() => nativeCommunityBundleSpec(prepared('dsh-purge', spec))).toThrow('trial-failed')
    })

  it('rejects conflicting prepared bundle identity instead of installing under a different package name', () => {
    expect(() => nativeCommunityBundleSpec({ ...prepared(), bundle: 'another-package' })).toThrow('trial-failed')
  })
})
