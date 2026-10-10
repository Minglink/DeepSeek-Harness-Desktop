/** Community account persistence uses private per-case data and an instance-local HTTP adapter. */
import fs from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loginCommunityAccount, logoutCommunityAccount, readCommunityAccount, saveCommunityAccount, saveConfig } from '../src/api-vault.ts'

let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-community-account-'))
  vi.stubEnv('DSH_HOME', directory)
  for (const key of ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL']) vi.stubEnv(key, '')
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await rm(directory, { recursive: true, force: true })
})

const account = { userId: '1', username: 'Example', email: 'example@example.test', token: 'fixture-token', savedAt: 1 }
describe('community account storage', () => {
  it('keeps the community session when provider settings are saved', () => {
    saveCommunityAccount(account)
    saveConfig({ apiKey: 'test-provider-key', baseUrl: 'https://example.test', aiModel: 'test-model' })
    expect(readCommunityAccount()).toEqual(account)
    logoutCommunityAccount()
    expect(readCommunityAccount()).toBeNull()
  })

  it('does not expose malformed persisted metadata as a signed-in account', async () => {
    await writeFile(join(directory, 'desktop-config.json'), JSON.stringify({ community: { ...account, username: {} } }))
    expect(readCommunityAccount()).toBeNull()
  })

  it('requires a valid login token and uses the existing HTTPS account endpoint', async () => {
    const result = await loginCommunityAccount('Example', 'fixture-password', async (input, init) => {
      expect(input).toBe('https://deepseek.stream/api/auth/login')
      expect(init?.redirect).toBe('error')
      expect(init?.credentials).toBe('omit')
      const headers = new Headers(init?.headers)
      expect(headers.get('origin')).toBe('https://deepseek.stream')
      expect(headers.get('content-type')).toBe('application/json')
      expect(headers.get('cookie')).toBeNull()
      expect(headers.get('authorization')).toBeNull()
      if (typeof init?.body !== 'string') throw new Error('Expected a JSON login request')
      const payload: unknown = JSON.parse(init.body)
      expect(payload).toEqual({ emailOrUsername: 'Example', password: 'fixture-password' })
      return Response.json({ success: true, user: { id: '1', username: 'Example', email: 'example@example.test' } }, {
        headers: { 'set-cookie': 'deepseek_hub_auth_token=fixture-token; HttpOnly; Secure' },
      })
    })
    expect(result).toEqual({ success: true, token: 'fixture-token' })
    expect(readCommunityAccount()?.username).toBe('Example')
  })

  it.each([
    ['missing-token', 'login-invalid-response'], ['invalid-json', 'login-invalid-response'],
    ['http-failure', 'login-invalid-credentials'], ['network-failure', 'login-network-failed'],
    ['response-disconnect', 'login-network-failed'],
  ])('keeps existing credentials after %s', async (failure, code) => {
    saveCommunityAccount(account)
    const before = await readFile(join(directory, 'desktop-config.json'), 'utf8')
    const result = await loginCommunityAccount('Example', 'fixture-password', async () => {
      if (failure === 'network-failure') throw new Error('private network diagnostic')
      if (failure === 'response-disconnect') return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.error(new Error('private connection diagnostic')) },
      }))
      if (failure === 'http-failure') return new Response(null, { status: 401 })
      if (failure === 'invalid-json') return new Response('{')
      return Response.json({ success: true, user: { id: '2' } })
    })
    expect(result).toEqual({ success: false, problem: { code } })
    expect(await readFile(join(directory, 'desktop-config.json'), 'utf8')).toBe(before)
  })

  it.each([
    [400, 'invalid-account'], [401, 'login-invalid-credentials'], [403, 'login-forbidden'],
    [429, 'login-rate-limited'], [503, 'login-server-failed'],
  ])('reports HTTP %s without disclosing server diagnostics or changing configuration', async (status, code) => {
    saveCommunityAccount(account)
    const before = await readFile(join(directory, 'desktop-config.json'), 'utf8')
    const result = await loginCommunityAccount('Example', 'private-password', async () =>
      Response.json({ error: 'private-server-diagnostic', token: 'private-server-token' }, { status }))
    expect(result).toEqual({ success: false, problem: { code } })
    expect(await readFile(join(directory, 'desktop-config.json'), 'utf8')).toBe(before)
    expect(JSON.stringify(result)).not.toMatch(/private-/u)
  })

  it.each(['oversized', 'empty-id', 'invalid-token', 'no-user', 'missing-body'])('rejects %s responses before saving an account', async (failure) => {
    saveCommunityAccount(account)
    const before = await readFile(join(directory, 'desktop-config.json'), 'utf8')
    const result = await loginCommunityAccount('Example', 'fixture-password', async () => {
      if (failure === 'oversized') return new Response(' '.repeat(1024 * 1024 + 1))
      if (failure === 'missing-body') return new Response(null)
      if (failure === 'no-user') return Response.json({ success: true, token: 'fixture-token' })
      return Response.json({ success: true, user: { id: failure === 'empty-id' ? '' : '2' },
        token: failure === 'invalid-token' ? 'token;unsafe' : 'fixture-token' })
    })
    expect(result).toEqual({ success: false, problem: { code: 'login-invalid-response' } })
    expect(await readFile(join(directory, 'desktop-config.json'), 'utf8')).toBe(before)
  })

  it('does not create account state after a failed first sign-in', async () => {
    const result = await loginCommunityAccount('Example', 'fixture-password', async () => new Response(null, { status: 401 }))
    expect(result).toEqual({ success: false, problem: { code: 'login-invalid-credentials' } })
    expect(await readdir(directory)).toEqual([])
  })

  it('atomically stores valid login metadata and retains unrelated configuration fields', async () => {
    const existing = { community: account, apiKey: 'fixture-provider-key', custom: { enabled: true }, communityAdaptation: { maxAttempts: 1 } }
    await writeFile(join(directory, 'desktop-config.json'), JSON.stringify(existing))
    const result = await loginCommunityAccount('Example', 'fixture-password', async () =>
      Response.json({ success: true, user: { id: 2, username: 'New user', email: 'new@example.test' }, token: 'new-token' }))
    expect(result).toEqual({ success: true, token: 'new-token' })
    const saved: unknown = JSON.parse(await readFile(join(directory, 'desktop-config.json'), 'utf8'))
    expect(saved).toMatchObject({ ...existing, community: { userId: '2', username: 'New user', email: 'new@example.test', token: 'new-token' } })
    expect((await readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it.each(['malformed-json', 'non-object', 'read-failure', 'write-failure', 'replace-failure'])('preserves the previous file when login storage encounters %s', async (failure) => {
    const config = join(directory, 'desktop-config.json')
    const before = failure === 'malformed-json' ? '{broken' : failure === 'non-object' ? '[]' : JSON.stringify({ community: account, custom: 'keep-me' })
    await writeFile(config, before)
    if (failure === 'read-failure') vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => { throw new Error('private-read-diagnostic') })
    if (failure === 'write-failure') vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => { throw new Error('private-write-diagnostic') })
    if (failure === 'replace-failure') vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('private-replace-diagnostic') })
    const result = await loginCommunityAccount('Example', 'private-password', async () =>
      Response.json({ success: true, user: { id: '2' }, token: 'private-new-token' }))
    expect(result).toEqual({ success: false, problem: { code: 'login-storage-failed' } })
    expect(JSON.stringify(result)).not.toMatch(/private-/u)
    expect(await readFile(config, 'utf8')).toBe(before)
    expect((await readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })
})
