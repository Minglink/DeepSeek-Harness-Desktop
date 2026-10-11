/** Preserve a verified local artifact's identity when the native manager reinstalls unchanged bytes. */
import { isAbsolute, resolve } from 'node:path'
import type { PreparedCommunityBundle } from './community-install.ts'
import { communityInfrastructureFailure } from './community-failure.ts'

/**
 * Name the manifest-verified package explicitly while retaining its immutable absolute tarball path.
 * @param prepared - Main-owned preparation result; spec remains the bare file path used for hash verification.
 * @returns One native pnpm argument, including scoped names and unescaped spaces/Unicode in local paths.
 */
export function nativeCommunityBundleSpec(prepared: PreparedCommunityBundle): string {
  const { packageName, spec } = prepared
  if (packageName.length > 214 || !/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u.test(packageName)
    || prepared.bundle !== packageName || !isAbsolute(spec) || /[\u0000-\u001f\u007f]/u.test(spec) || !spec.endsWith('.tgz')) {
    throw communityInfrastructureFailure('preparation')
  }
  return `${packageName}@file:${resolve(spec).replace(/\\/gu, '/')}`
}
