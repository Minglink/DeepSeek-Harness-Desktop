/** Main-owned market requests survive renderer reloads; website requests use fixed community destinations. */
import { randomUUID } from 'node:crypto'
import type { CommunityNavigationId } from './community-types.ts'

/**
 * Resolve a website request from product IPC to a canonical community destination.
 * @param path - Existing Hub route or one of the two supported external account routes.
 * @param target - Undefined for the shared Hub window, or system-browser for account onboarding.
 * @returns A validated route, HTTPS URL, and presentation target without account credentials.
 */
export function communityWebsiteDestination(path: unknown, target: unknown): {
  readonly path: string
  readonly url: string
  readonly target: 'hub' | 'system-browser'
} {
  if (path !== undefined && (typeof path !== 'string' || path !== path.trim()
    || !/^\/(?:plugins(?:\/[a-z0-9._-]+)?|auth\/(?:login|register)|profile|dashboard|guide)?$/u.test(path))) {
    throw new Error('Invalid community destination')
  }
  if (target !== undefined && target !== 'system-browser') throw new Error('Invalid community website target')
  const route = typeof path === 'string' ? path : '/'
  if (target === 'system-browser' && route !== '/' && route !== '/auth/register') throw new Error('Invalid external community destination')
  return { path: route, url: new URL(route, 'https://deepseek.stream').href, target: target ?? 'hub' }
}

/** Preserve market navigation across renderer reloads and ignore acknowledgements of replaced requests. */
export class DesktopCommunityNavigation {
  private pending: CommunityNavigationId | null = null

  /** @returns The new pending request, replacing any previous request for the same market panel. */
  request(): CommunityNavigationId {
    this.pending = randomUUID() as CommunityNavigationId
    return this.pending
  }

  /** @returns The pending request without consuming it; an unloading client may discard its reply. */
  claim(): CommunityNavigationId | null {
    return this.pending
  }

  /**
   * @param value - Request identifier received across Electron IPC after successful panel selection.
   * @returns Whether this acknowledgement consumed the current request.
   */
  acknowledge(value: unknown): boolean {
    if (typeof value !== 'string' || !/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u.test(value)) {
      throw new Error('Invalid community navigation request')
    }
    if (this.pending !== value) return false
    this.pending = null
    return true
  }
}
