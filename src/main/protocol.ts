/**
 * Protocol parser and validator for `dsh://` custom URI scheme.
 * Spec: dsh://plugin/install?id={id}&name={name}&version={version}&repo={repo}&permissions={permissions}&downloadUrl={downloadUrl}
 */

export interface DshPluginInstallPayload {
  id: string
  name: string
  version: string
  repo: string
  permissions: string[]
  downloadUrl?: string
  rawUrl: string
}

/**
 * Parses and validates a raw `dsh://` URL string.
 * @param rawUrl The raw URL or CLI argument (e.g. `dsh://plugin/install?...`)
 * @returns Parsed payload or null if not a valid plugin install request.
 */
export function parseDshProtocolUrl(rawUrl: string): DshPluginInstallPayload | null {
  if (!rawUrl || typeof rawUrl !== 'string') return null

  const trimmed = rawUrl.trim()
  if (!trimmed.toLowerCase().startsWith('dsh://') && !trimmed.toLowerCase().startsWith('dsh:')) {
    return null
  }

  try {
    // Normalize dsh: or dsh://
    let urlString = trimmed
    if (urlString.startsWith('dsh://') && !urlString.startsWith('dsh:///')) {
      // e.g. dsh://plugin/install?id=...
      // In WHATWG URL, 'plugin' is the host, '/install' is the pathname.
    } else if (urlString.startsWith('dsh:')) {
      urlString = 'dsh://' + urlString.slice(4).replace(/^\/+/, '')
    }

    const parsed = new URL(urlString)
    const hostAndPath = (parsed.host + parsed.pathname).toLowerCase().replace(/^\/+/, '').replace(/\/+$/, '')

    // Supported paths: plugin/install or install
    if (hostAndPath !== 'plugin/install' && hostAndPath !== 'install' && !hostAndPath.endsWith('/plugin/install')) {
      console.warn(`[dsh-protocol] Unrecognized route: ${hostAndPath}`)
      return null
    }

    const params = parsed.searchParams
    const id = (params.get('id') || '').trim().toLowerCase()
    const name = (params.get('name') || id).trim()
    const version = (params.get('version') || 'latest').trim()
    const repo = (params.get('repo') || id).trim()
    const permissionsRaw = params.get('permissions') || ''
    const downloadUrl = (params.get('downloadUrl') || '').trim() || undefined

    if (!id && !repo) {
      console.warn('[dsh-protocol] Missing required "id" or "repo" parameter')
      return null
    }

    // Parse permissions into an array of strings
    const permissions = permissionsRaw
      ? permissionsRaw.split(/[,;|，；、\n]+/).map(p => p.trim()).filter(Boolean)
      : ['常规运行权限']

    return {
      id: id || repo.replace(/^.*[\\/]/, ''),
      name: name || id,
      version: version || 'latest',
      repo: repo || id,
      permissions,
      downloadUrl,
      rawUrl: trimmed,
    }
  } catch (err) {
    console.error(`[dsh-protocol] Failed to parse URL: ${rawUrl}`, err)
    return null
  }
}
