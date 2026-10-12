/** Public market HTTP fixtures exercise website paging and metadata projection without accounts or live requests. */
import { describe, expect, it, vi } from 'vitest'
import { communityCatalogPlugin, communityCatalogQuery, loadCommunityCatalog, loadCommunityPlugin } from '../src/community-catalog.ts'

const plugin = (id = 'addon'): object => ({ id, name: 'Addon', version: '1.2.3', description: 'Community addon' })
const page = (plugins: readonly object[], total = plugins.length, currentPage = 1, pageSize = 15): object => ({
  plugins, total, page: currentPage, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)),
})

describe('community website query options', () => {
  it('resolves defaults and preserves the website search and ranking fields', () => {
    expect(communityCatalogQuery(undefined)).toEqual({ page: 1, pageSize: 15, sortBy: 'hot' })
    expect(communityCatalogQuery({ query: '  browser  ', category: 'tools', tag: '浏览器', platform: 'desktop-exe',
      source: 'user_upload', sortBy: 'essential', page: 2, pageSize: 20 })).toEqual({ query: 'browser', category: 'tools',
      tag: '浏览器', platform: 'desktop-exe', source: 'user_upload', sortBy: 'essential', page: 2, pageSize: 20 })
  })

  it.each([
    null, [], { token: 'secret' }, { uploaderId: 'other-user' }, { query: '\u0000' }, { query: 'x'.repeat(257) },
    { platform: 'windows' }, { source: 'trusted' }, { sortBy: 'custom' }, { page: 0 }, { page: 1.5 },
    { page: '1' }, { pageSize: 51 }, { pageSize: Number.NaN },
  ])('refuses invalid IPC filters: %j', (query) => {
    expect(() => communityCatalogQuery(query)).toThrow()
  })
})

describe('community website catalog pages', () => {
  it('sends one server-filtered page with explicit anonymous HTTP options', async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json(page([plugin('two')], 2, 2, 1)))
    const catalog = await loadCommunityCatalog({ query: '浏览器', category: 'tools', tag: 'files', platform: 'desktop-exe',
      source: 'community', sortBy: 'downloads', page: 2, pageSize: 1 }, { fetch: request })
    expect(request).toHaveBeenCalledTimes(1)
    const input = request.mock.calls[0]?.[0]
    expect(input).toBeInstanceOf(URL)
    const url = new URL(String(input))
    expect(url.origin).toBe('https://deepseek.stream')
    expect(url.pathname).toBe('/api/plugins')
    expect(Object.fromEntries(url.searchParams)).toEqual({ query: '浏览器', category: 'tools', tag: 'files',
      platform: 'desktop-exe', source: 'community', sortBy: 'downloads', page: '2', pageSize: '1' })
    expect(request.mock.calls[0]?.[1]).toMatchObject({ credentials: 'omit', redirect: 'error', headers: { accept: 'application/json' } })
    expect(catalog).toMatchObject({ cached: false, total: 2, page: 2, pageSize: 1, totalPages: 2, plugins: [{ id: 'two' }] })
  })

  it('projects rich metadata while dropping executable sources and account data', async () => {
    const item = { ...plugin(), tags: ['files'], platform: 'desktop-exe', source: 'community', icon: '🐳', price: 8,
      compatibilityNote: 'Verified with 0.2.1', harnessVersion: '0.2.1', npmPackage: '@author/addon', permissions: ['Read files'],
      screenshots: ['/screenshots/addon.png', 'https://cdn.example.com/addon.jpg', 'javascript:alert(1)', 'https://cdn.example.com/a.png?token=secret'],
      readme: '# Addon\n\nUsage', token: 'private', userId: 'private-user', downloadUrl: 'https://example.com/private',
      downloadSha256: 'untrusted-checksum', githubRepo: 'author/addon' }
    const catalog = await loadCommunityCatalog({}, { fetch: async () => Response.json(page([item])) })
    expect(catalog.plugins[0]).toEqual({ id: 'addon', name: 'Addon', version: '1.2.3', description: 'Community addon',
      tags: ['files'], platform: 'desktop-exe', source: 'community', icon: '🐳', price: 8, compatibility: 'Verified with 0.2.1',
      harnessVersion: '0.2.1', npmPackage: '@author/addon', permissions: ['Read files'], readme: '# Addon\n\nUsage',
      screenshots: ['https://deepseek.stream/screenshots/addon.png', 'https://cdn.example.com/addon.jpg'] })
    expect(JSON.stringify(catalog)).not.toMatch(/private|downloadUrl|downloadSha256|githubRepo|token/u)
  })

  it('omits invalid records and counts them without treating a wholly invalid page as empty', async () => {
    const catalog = await loadCommunityCatalog({}, { fetch: async () => Response.json(page([plugin(), { ...plugin(), id: '../unsafe' }])) })
    expect(catalog).toMatchObject({ plugins: [{ id: 'addon' }], skippedCount: 1, total: 2 })
    await expect(loadCommunityCatalog({}, { fetch: async () => Response.json(page([{ id: '../unsafe' }])) })).rejects.toThrow('no compatible package records')
  })

  it.each([
    { ...page([plugin()]), page: 2 }, { ...page([plugin()]), pageSize: 50 }, { ...page([plugin()]), totalPages: 999 },
    { ...page([plugin()]), total: -1 }, { ...page([plugin()]), total: 1.5 }, page([], 1), page([plugin()], 0),
  ])('refuses incomplete or inconsistent server pagination: %j', async (payload) => {
    await expect(loadCommunityCatalog({}, { fetch: async () => Response.json(payload) })).rejects.toThrow('pagination')
  })

  it('accepts the website empty-catalog pagination', async () => {
    await expect(loadCommunityCatalog({}, { fetch: async () => Response.json(page([])) })).resolves.toMatchObject({ plugins: [], total: 0, totalPages: 1 })
  })

  it('bounds declared and streamed response bytes and refuses malformed JSON', async () => {
    await expect(loadCommunityCatalog({}, { fetch: async () => new Response('{}', { headers: { 'content-length': '3000000' } }) })).rejects.toThrow('size limit')
    await expect(loadCommunityCatalog({}, { fetch: async () => new Response(' '.repeat(2 * 1_024 * 1_024 + 1)) })).rejects.toThrow('size limit')
    await expect(loadCommunityCatalog({}, { fetch: async () => new Response('{') })).rejects.toThrow('valid JSON')
  })

  it('preserves the cancellation signal and does not send an already-cancelled query', async () => {
    const controller = new AbortController()
    controller.abort(new Error('Fixture cancelled'))
    const request = vi.fn<typeof fetch>()
    await expect(loadCommunityCatalog({}, { fetch: request, signal: controller.signal })).rejects.toThrow('Fixture cancelled')
    expect(request).not.toHaveBeenCalled()
  })

  it('classifies transport failures without exposing adapter diagnostics', async () => {
    const failure = await loadCommunityCatalog({}, { fetch: async () => { throw new Error('Private transport token=secret') } }).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'catalog-unavailable', message: 'Community catalog request failed; check the connection and retry' })
    expect(String(failure)).not.toMatch(/Private|secret/u)
  })
})

describe('community website plugin detail', () => {
  it.each([true, false, null, {}, { kind: 'author-application', docsUrl: 'https://private.invalid/?token=secret', reason: 'private-author-command' }])('keeps every explicit installation boundary blocked and display-only through cache projection: %j', async (installationBoundary) => {
    const detail = await loadCommunityPlugin('addon', { fetch: async () => Response.json({ plugin: { ...plugin(), installationBoundary } }) })
    expect(detail).toEqual({ id: 'addon', name: 'Addon', version: '1.2.3', description: 'Community addon', installationBoundary: true })
    expect(communityCatalogPlugin(detail)).toEqual(detail)
    expect(JSON.stringify(detail)).not.toMatch(/docsUrl|private|secret|reason/u)
  })

  it('keeps manual full-package downloads display-only through detail and cached catalog projection', async () => {
    const manualDistribution = { kind: 'github-release', installMethod: 'author-script', platform: 'windows-x64',
      downloadUrl: 'https://github.com/author/addon/releases/download/v1.2.3/full.zip', script: 'private-author-command' }
    const detail = await loadCommunityPlugin('addon', { fetch: async () => Response.json({ plugin: { ...plugin(), manualDistribution } }) })
    expect(detail).toEqual({ id: 'addon', name: 'Addon', version: '1.2.3', description: 'Community addon', manualDistribution: true })
    expect(communityCatalogPlugin(detail)).toEqual(detail)
    expect(JSON.stringify(detail)).not.toMatch(/downloadUrl|private-author-command|github/u)
  })

  it.each([false, 'author-script', {}, { kind: 'url', installMethod: 'author-script', platform: 'windows-x64' }])('refuses unsupported manual metadata instead of showing automatic installation: %j', (manualDistribution) => {
    expect(() => communityCatalogPlugin({ ...plugin(), manualDistribution })).toThrow('manual community distribution')
  })

  it('loads the website detail route and preserves its README and compatibility notes', async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ plugin: { ...plugin(), readme: '# Addon\n\nInstructions', compatibilityNote: '0.2.1',
      screenshots: ['https://cdn.example.com/addon.png'] }, reviews: [{ userId: 'private-user' }] }))
    await expect(loadCommunityPlugin('addon', { fetch: request })).resolves.toMatchObject({ id: 'addon', readme: '# Addon\n\nInstructions', compatibility: '0.2.1' })
    expect(String(request.mock.calls[0]?.[0])).toBe('https://deepseek.stream/api/plugins/addon')
  })

  it('refuses invalid selections before requesting and mismatched response identities', async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ plugin: plugin('other') }))
    await expect(loadCommunityPlugin('../addon', { fetch: request })).rejects.toThrow('identity')
    expect(request).not.toHaveBeenCalled()
    await expect(loadCommunityPlugin('addon', { fetch: request })).rejects.toThrow('identity changed')
  })

  it('classifies missing plugins without exposing response text', async () => {
    const failure = await loadCommunityPlugin('addon', { fetch: async () => new Response('private server error', { status: 404 }) }).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'plugin-not-found', message: 'Community catalog returned HTTP 404' })
    expect(String(failure)).not.toContain('private')
  })

  it('drops unsafe optional images, invalid npm identifiers, and invalid prices', () => {
    expect(communityCatalogPlugin({ ...plugin(), icon: 'data:image/svg+xml,<svg/>', npmPackage: '../shell', price: -1,
      tags: [1], permissions: { all: true }, screenshots: ['https://user:password@cdn.example.com/a.png'] })).toEqual({
      id: 'addon', name: 'Addon', version: '1.2.3', description: 'Community addon', screenshots: [],
    })
  })
})
