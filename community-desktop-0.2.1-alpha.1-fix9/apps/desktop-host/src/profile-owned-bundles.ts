/** Installed direct dependencies whose bundle identity belongs to this Desktop profile. */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readProfileManifest } from '@deepseek-ai/dsh-app-boot'

/**
 * Read only the profile's explicit direct dependencies and their installed manifests.
 * @param profileDir - Actual application-owned package project.
 * @param stockAnchors - Deployment-owned stock identities, after verified private alias mapping.
 * @returns Installed direct bundle identities; omitted packages remain native-install repairable.
 */
export function desktopProfileOwnedBundles(profileDir: string, stockAnchors: readonly string[]): readonly string[] {
  const manifest = readProfileManifest('dsh', profileDir)
  const dependencies: unknown = manifest.dependencies ?? {}
  if (typeof dependencies !== 'object' || dependencies === null || Array.isArray(dependencies)
    || !Object.values(dependencies).every(spec => typeof spec === 'string' && spec.length > 0)) {
    throw new Error('Desktop profile dependencies must be an explicit package-spec mapping')
  }
  const names: string[] = []
  for (const name of Object.keys(dependencies)) {
    if (!/^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/.test(name) || name === '.' || name === '..') {
      throw new Error('Desktop profile contains an invalid dependency identity')
    }
    if (stockAnchors.includes(name)) continue
    const installedDir = join(profileDir, 'node_modules', name)
    if (!existsSync(join(installedDir, 'package.json'))) continue
    const installed = readProfileManifest('dsh', installedDir)
    if (installed.name !== name) throw new Error(`Desktop profile dependency ${JSON.stringify(name)} has a different installed identity`)
    if (installed.dsh?.bundle !== undefined) names.push(name)
  }
  return Object.freeze(names)
}
