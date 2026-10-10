/** Renderer reloads must not consume menu requests before a live panel has selected them. */
import { describe, expect, it } from 'vitest'
import { DesktopCommunityNavigation, communityWebsiteDestination } from '../src/community-navigation.ts'

describe('market navigation ownership', () => {
  it('retains an unanswered claim for a replacement renderer', () => {
    const navigation = new DesktopCommunityNavigation()
    expect(navigation.claim()).toBeNull()
    const request = navigation.request()
    expect(navigation.claim()).toBe(request)
    expect(navigation.claim()).toBe(request)
    expect(navigation.acknowledge(request)).toBe(true)
    expect(navigation.claim()).toBeNull()
    expect(navigation.acknowledge(request)).toBe(false)
  })

  it('keeps a newer menu request when the old renderer acknowledges a replaced one', () => {
    const navigation = new DesktopCommunityNavigation()
    const old = navigation.request()
    const current = navigation.request()
    expect(current).not.toBe(old)
    expect(navigation.acknowledge(old)).toBe(false)
    expect(navigation.claim()).toBe(current)
    expect(navigation.acknowledge(current)).toBe(true)
    expect(navigation.claim()).toBeNull()
  })

  it.each([null, true, 1, '', 'community-market', '../request', '0'.repeat(36)])('rejects invalid IPC acknowledgements: %j', (value) => {
    const navigation = new DesktopCommunityNavigation()
    const request = navigation.request()
    expect(() => navigation.acknowledge(value)).toThrow('Invalid community navigation request')
    expect(navigation.claim()).toBe(request)
  })
})

describe('community website destinations', () => {
  it.each([undefined, '/', '/plugins', '/plugins/dsh-purge', '/auth/login', '/auth/register', '/profile', '/dashboard', '/guide'])('retains the existing Hub route %j', (path) => {
    expect(communityWebsiteDestination(path, undefined)).toEqual({
      path: path ?? '/', url: `https://deepseek.stream${path ?? '/'}`, target: 'hub',
    })
  })

  it.each(['/', '/auth/register'])('opens the fixed account route %s without passing credentials', (path) => {
    expect(communityWebsiteDestination(path, 'system-browser')).toEqual({
      path, url: `https://deepseek.stream${path}`, target: 'system-browser',
    })
  })

  it.each([null, 1, '', '//example.test/', 'https://deepseek.stream/auth/register', '/auth/register?password=private',
    '/auth/register#private', '/auth/register/', '/auth/register\n', '/plugins/../dashboard', '/plugins/a%2Fb'])('rejects noncanonical IPC routes: %j', (path) => {
    expect(() => communityWebsiteDestination(path, undefined)).toThrow('Invalid community destination')
    expect(() => communityWebsiteDestination(path, 'system-browser')).toThrow('Invalid community destination')
  })

  it.each(['browser', '', true, null, { external: true }])('rejects unsupported presentation targets: %j', (target) => {
    expect(() => communityWebsiteDestination('/auth/register', target)).toThrow('Invalid community website target')
  })

  it.each(['/auth/login', '/plugins', '/plugins/dsh-purge', '/profile', '/dashboard', '/guide'])('keeps %s out of external account onboarding', (path) => {
    expect(() => communityWebsiteDestination(path, 'system-browser')).toThrow('Invalid external community destination')
  })
})
