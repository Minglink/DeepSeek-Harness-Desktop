/** Desktop provider settings and main-owned community credentials. */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import https from 'node:https'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import type { CommunityAdaptationLimits } from './community-adaptation.ts'
import type { CommunityLoginProblem } from './community-types.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isCommunityAccount(value: unknown): value is CommunityAccount {
  return isRecord(value) && typeof value.userId === 'string' && typeof value.username === 'string'
    && typeof value.email === 'string' && typeof value.token === 'string' && value.token.length > 0
    && value.token.length <= 8192 && !/[\u0000-\u0020\u007f;]/u.test(value.token)
    && typeof value.savedAt === 'number' && Number.isFinite(value.savedAt)
    && (value.role === undefined || typeof value.role === 'string')
}

/** Stored community session; never returned through a renderer bridge. */
export interface CommunityAccount {
  userId: string
  username: string
  email: string
  role?: string
  token: string
  savedAt: number
}

export interface DesktopConfig {
  apiKey: string
  baseUrl: string
  aiModel: string
  community?: CommunityAccount
  communityAdaptation?: Partial<CommunityAdaptationLimits>
}

export function getDshHome(): string {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

export function getConfigPaths() {
  const home = getDshHome()
  return {
    home,
    configJson: path.join(home, 'desktop-config.json'),
    credentialsYaml: path.join(home, '.credentials.yaml'),
    envFile: path.join(home, '.env'),
  }
}

export function readConfig(): DesktopConfig {
  const { configJson, credentialsYaml } = getConfigPaths()

  let apiKey = process.env.DEEPSEEK_API_KEY || ''
  let baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'
  let aiModel = process.env.DEEPSEEK_MODEL || 'deepseek-chat'
  let community: CommunityAccount | undefined = undefined
  let adaptationInput: unknown

  if (fs.existsSync(configJson)) {
    try {
      const data: unknown = JSON.parse(fs.readFileSync(configJson, 'utf8'))
      if (isRecord(data)) {
        if (typeof data.apiKey === 'string' && data.apiKey) apiKey = data.apiKey
        if (typeof data.baseUrl === 'string' && data.baseUrl) baseUrl = data.baseUrl
        if (typeof data.aiModel === 'string' && data.aiModel) aiModel = data.aiModel
        if (isCommunityAccount(data.community)) community = data.community
        adaptationInput = data.communityAdaptation
      }
    } catch {}
  }

  if (!apiKey && fs.existsSync(credentialsYaml)) {
    try {
      const content = fs.readFileSync(credentialsYaml, 'utf8')
      const match = /DEEPSEEK_API_KEY:\s*["']?([^"'\r\n]+)["']?/.exec(content)
      if (match && match[1]) {
        apiKey = match[1].trim()
      }
    } catch {}
  }

  const communityAdaptation = readAdaptationLimits(adaptationInput)
  return { apiKey, baseUrl, aiModel, ...(community ? { community } : {}),
    ...(communityAdaptation === undefined ? {} : { communityAdaptation }) }
}

function readAdaptationLimits(value: unknown): Partial<CommunityAdaptationLimits> | undefined {
  if (value === undefined) return undefined
  const keys = ['maxAttempts', 'timeoutMs', 'maxContextBytes', 'maxResponseBytes', 'maxFiles', 'maxFileBytes', 'maxOutputTokens'] as const
  if (!isRecord(value) || Object.keys(value).some(key => !keys.some(allowed => key === allowed))) throw new Error('Invalid community adaptation limits')
  const result: Partial<CommunityAdaptationLimits> = {}
  for (const key of keys) {
    const item = value[key]
    if (item === undefined) continue
    if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 1) throw new Error(`Invalid community adaptation limit ${key}`)
    result[key] = item
  }
  return result
}

export function hasValidApiKey(): boolean {
  const { apiKey } = readConfig()
  return typeof apiKey === 'string' && apiKey.trim().length >= 10
}

export function saveConfig({ apiKey, baseUrl, aiModel }: DesktopConfig): boolean {
  const { home, configJson, credentialsYaml, envFile } = getConfigPaths()

  if (!fs.existsSync(home)) {
    fs.mkdirSync(home, { recursive: true })
  }

  const cleanKey = (apiKey || '').trim()
  const cleanUrl = (baseUrl || 'https://api.deepseek.com').trim().replace(/\/+$/, '')
  const cleanModel = (aiModel || 'deepseek-chat').trim()

  // 1. Write desktop-config.json
  const configData = {
    ...readConfig(),
    apiKey: cleanKey,
    baseUrl: cleanUrl,
    aiModel: cleanModel,
    updatedAt: new Date().toISOString(),
  }
  fs.writeFileSync(configJson, JSON.stringify(configData, null, 2) + '\n', 'utf8')

  // 2. Write .credentials.yaml for dsh-credentials-local (version 1)
  const yamlContent = `version: 1\nrefs:\n  DEEPSEEK_API_KEY: "${cleanKey}"\n`
  fs.writeFileSync(credentialsYaml, yamlContent, 'utf8')

  // 3. Write .env (CRITICAL: DEEPSEEK_BASE_URL is a bootstrap variable and MUST NOT be in .env!)
  if (cleanKey) {
    fs.writeFileSync(envFile, `DEEPSEEK_API_KEY=${cleanKey}\n`, 'utf8')
  } else if (fs.existsSync(envFile)) {
    try { fs.unlinkSync(envFile) } catch {}
  }

  // 4. Update current runtime environment variables
  process.env.DEEPSEEK_API_KEY = cleanKey
  process.env.DEEPSEEK_BASE_URL = cleanUrl
  process.env.DEEPSEEK_MODEL = cleanModel

  return true
}

export function testApiConnection(apiKey: string, baseUrl = 'https://api.deepseek.com'): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  return new Promise((resolve) => {
    try {
      const cleanKey = (apiKey || '').trim()
      const cleanUrl = (baseUrl || 'https://api.deepseek.com').trim().replace(/\/+$/, '')

      if (!cleanKey) {
        resolve({ ok: false, error: '请输入有效的 API Key' })
        return
      }

      const parsed = new URL(`${cleanUrl}/models`)
      const isHttps = parsed.protocol === 'https:'
      const client = isHttps ? https : http

      const startTime = Date.now()
      const req = client.request({
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${cleanKey}`,
          'User-Agent': 'DeepSeek-Harness-Desktop/0.1.6-max',
          'Accept': 'application/json',
        },
        timeout: 10000,
      }, (res) => {
        const latencyMs = Date.now() - startTime
        res.resume()
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ ok: true, latencyMs })
          } else if (res.statusCode === 401) {
            resolve({ ok: false, error: 'API Key 无效或未授权 (401)' })
          } else {
            resolve({ ok: false, error: `服务器返回状态码 ${res.statusCode}` })
          }
        })
      })

      req.on('error', (err) => {
        resolve({ ok: false, error: `网络连接失败: ${err.message}` })
      })

      req.on('timeout', () => {
        req.destroy()
        resolve({ ok: false, error: '网络连接超时 (10 秒)' })
      })

      req.end()
    } catch (error) {
      resolve({ ok: false, error: error instanceof Error ? error.message : '未知错误' })
    }
  })
}

/**
 * Generates the UI-Craft compliant Onboarding Wizard HTML
 * Follows UI Craft rules:
 * - Rule 1 & 10: Clean hierarchy, subtle chrome
 * - Rule 2: Single 44pt primary pill at thumb zone
 * - Rule 13: Compact buttons (36pt test button)
 * - Rule 15: Brand vertical glow & frosted cards
 * - Rule 16: States are icons, problems are words
 */
export function getOnboardingHtml(config: DesktopConfig): string {
  const currentModel = config.aiModel || 'deepseek-chat'
  const isCustomModel = currentModel !== 'deepseek-chat' && currentModel !== 'deepseek-reasoner'

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>DeepSeek API 配置向导</title>
  <style>
    :root {
      --bg-base: #0b1120;
      --bg-card: rgba(30, 41, 59, 0.7);
      --border-card: rgba(51, 65, 85, 0.6);
      --border-focus: #0284c7;
      --text-main: #f8fafc;
      --text-secondary: #94a3b8;
      --accent: #0284c7;
      --accent-hover: #0369a1;
      --success: #10b981;
      --error: #ef4444;
      --font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; user-select: none; }
    body {
      background-color: var(--bg-base);
      color: var(--text-main);
      font-family: var(--font-family);
      height: 100vh;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      padding: 24px;
      /* UI Craft Rule 15: Brand atmosphere from vertical glow */
      background-image:
        radial-gradient(ellipse 80% 50% at 50% -20%, rgba(2, 132, 199, 0.25) 0%, transparent 70%),
        radial-gradient(circle at 90% 90%, rgba(99, 102, 241, 0.08) 0%, transparent 50%);
    }
    .header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 20px;
    }
    .brand-icon {
      width: 44px;
      height: 44px;
      border-radius: 12px;
      background: linear-gradient(135deg, #0284c7, #2563eb);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 22px;
      box-shadow: 0 4px 14px rgba(2, 132, 199, 0.35);
    }
    .header-text h1 {
      font-size: 17px;
      font-weight: 700;
      color: #ffffff;
      letter-spacing: -0.01em;
    }
    .header-text p {
      font-size: 13px;
      color: var(--text-secondary);
      margin-top: 2px;
    }
    .form-group {
      margin-bottom: 14px;
    }
    .label {
      display: block;
      font-size: 12px;
      font-weight: 600;
      color: var(--text-secondary);
      margin-bottom: 6px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .input-wrap {
      position: relative;
      display: flex;
      align-items: center;
    }
    input, select {
      width: 100%;
      height: 42px;
      background: rgba(15, 23, 42, 0.8);
      border: 1px solid var(--border-card);
      border-radius: 10px;
      padding: 0 12px;
      color: var(--text-main);
      font-size: 14px;
      outline: none;
      transition: all 0.18s ease;
      backdrop-filter: blur(8px);
    }
    input:focus, select:focus {
      border-color: var(--border-focus);
      box-shadow: 0 0 0 3px rgba(2, 132, 199, 0.15);
    }
    .btn-test {
      height: 36px;
      padding: 0 14px;
      border-radius: 8px;
      background: rgba(51, 65, 85, 0.8);
      border: 1px solid rgba(71, 85, 105, 0.6);
      color: #e2e8f0;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      white-space: nowrap;
      margin-left: 8px;
      transition: all 0.18s;
    }
    .btn-test:hover {
      background: #334155;
      color: #ffffff;
    }
    .test-result {
      font-size: 12px;
      margin-top: 6px;
      display: flex;
      align-items: center;
      gap: 6px;
      min-height: 18px;
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 2px 8px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 600;
    }
    .status-success {
      background: rgba(16, 185, 129, 0.15);
      color: var(--success);
      border: 1px solid rgba(16, 185, 129, 0.3);
    }
    .status-error {
      background: rgba(239, 68, 68, 0.15);
      color: var(--error);
      border: 1px solid rgba(239, 68, 68, 0.3);
    }
    /* UI Craft Rule 2: Single 44pt Primary Pill at the bottom */
    .footer {
      margin-top: auto;
      padding-top: 16px;
      display: flex;
      gap: 12px;
    }
    .btn-save {
      flex: 1;
      height: 44px;
      border-radius: 22px;
      background: linear-gradient(135deg, #0284c7, #2563eb);
      border: none;
      color: #ffffff;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 4px 14px rgba(2, 132, 199, 0.3);
      transition: all 0.2s ease;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }
    .btn-save:hover {
      transform: translateY(-1px);
      box-shadow: 0 6px 18px rgba(2, 132, 199, 0.45);
    }
    .btn-save:active {
      transform: translateY(0);
    }
    .btn-cancel {
      width: 90px;
      height: 44px;
      border-radius: 22px;
      background: rgba(30, 41, 59, 0.8);
      border: 1px solid var(--border-card);
      color: var(--text-secondary);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.18s;
    }
    .btn-cancel:hover {
      background: #334155;
      color: #ffffff;
    }
    .helper-text {
      font-size: 11px;
      color: #64748b;
      margin-top: 4px;
      line-height: 1.4;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="brand-icon">⚡</div>
    <div class="header-text">
      <h1>DeepSeek API 密钥与模型配置</h1>
      <p>配置安全密钥与端点，即刻开启全功能智能体</p>
    </div>
  </div>

  <div class="form-group">
    <label class="label" for="api-key">DeepSeek API Key</label>
    <div class="input-wrap">
      <input type="password" id="api-key" placeholder="sk-..." value="${config.apiKey || ''}" spellcheck="false" autocomplete="off" />
      <button class="btn-test" id="btn-test" type="button">
        <span id="test-icon">🔍</span>
        <span id="test-text">测速</span>
      </button>
    </div>
    <div class="test-result" id="test-result"></div>
  </div>

  <div class="form-group">
    <label class="label" for="base-url">API Base URL</label>
    <input type="text" id="base-url" placeholder="https://api.deepseek.com" value="${config.baseUrl || 'https://api.deepseek.com'}" spellcheck="false" />
    <p class="helper-text">官方直连端点为 https://api.deepseek.com，兼容支持 OpenAI 格式的第三方镜像</p>
  </div>

  <div class="form-group">
    <label class="label" for="ai-model">默认智能体模型</label>
    <select id="ai-model">
      <option value="deepseek-chat" ${currentModel === 'deepseek-chat' ? 'selected' : ''}>deepseek-chat (V3 通用对话 / 快速编码)</option>
      <option value="deepseek-reasoner" ${currentModel === 'deepseek-reasoner' ? 'selected' : ''}>deepseek-reasoner (R1 深度推理 / 复杂架构)</option>
      <option value="custom" ${isCustomModel ? 'selected' : ''}>自定义模型...</option>
    </select>
  </div>

  <div class="form-group" id="custom-model-group" style="display: ${isCustomModel ? 'block' : 'none'};">
    <label class="label" for="custom-model">自定义模型名称</label>
    <input type="text" id="custom-model" placeholder="输入自定义模型标识..." value="${isCustomModel ? currentModel : ''}" />
  </div>

  <div class="footer">
    <button class="btn-cancel" id="btn-cancel" type="button">取消</button>
    <button class="btn-save" id="btn-save" type="button">
      <span>🚀</span>
      <span>保存并启动 Harness</span>
    </button>
  </div>

  <script>
    const { ipcRenderer } = require('electron');

    const apiKeyInput = document.getElementById('api-key');
    const baseUrlInput = document.getElementById('base-url');
    const aiModelSelect = document.getElementById('ai-model');
    const customModelGroup = document.getElementById('custom-model-group');
    const customModelInput = document.getElementById('custom-model');
    const btnTest = document.getElementById('btn-test');
    const testResult = document.getElementById('test-result');
    const btnSave = document.getElementById('btn-save');
    const btnCancel = document.getElementById('btn-cancel');

    aiModelSelect.addEventListener('change', () => {
      customModelGroup.style.display = aiModelSelect.value === 'custom' ? 'block' : 'none';
      if (aiModelSelect.value === 'custom') customModelInput.focus();
    });

    btnTest.addEventListener('click', () => {
      const apiKey = apiKeyInput.value.trim();
      const baseUrl = baseUrlInput.value.trim();
      if (!apiKey) {
        testResult.innerHTML = '<span class="status-badge status-error">⚠️ 请先输入 API Key</span>';
        return;
      }
      btnTest.disabled = true;
      document.getElementById('test-text').innerText = '测试中...';
      testResult.innerHTML = '<span style="color: #94a3b8; font-size: 11px;">正在探测节点延迟...</span>';

      ipcRenderer.send('test-api-key', { apiKey, baseUrl });
    });

    ipcRenderer.on('test-api-key-result', (_event, { ok, latencyMs, error }) => {
      btnTest.disabled = false;
      document.getElementById('test-text').innerText = '测速';
      if (ok) {
        testResult.innerHTML = \`<span class="status-badge status-success">✅ 连接正常 · \${latencyMs}ms</span>\`;
      } else {
        testResult.innerHTML = \`<span class="status-badge status-error">❌ \${error || '连接失败'}</span>\`;
      }
    });

    btnSave.addEventListener('click', () => {
      const apiKey = apiKeyInput.value.trim();
      const baseUrl = baseUrlInput.value.trim() || 'https://api.deepseek.com';
      let aiModel = aiModelSelect.value;
      if (aiModel === 'custom') {
        aiModel = customModelInput.value.trim() || 'deepseek-chat';
      }

      if (!apiKey) {
        testResult.innerHTML = '<span class="status-badge status-error">⚠️ API Key 不能为空</span>';
        apiKeyInput.focus();
        return;
      }

      ipcRenderer.send('save-api-key', { apiKey, baseUrl, aiModel });
      window.close();
    });

    btnCancel.addEventListener('click', () => {
      window.close();
    });
  </script>
</body>
</html>`
}

export function readCommunityAccount(): CommunityAccount | null {
  const cfg = readConfig()
  return cfg.community ?? null
}

/**
 * Atomically update the community session while retaining every other valid configuration field.
 * @param account - Next main-owned session, or null to remove only that session.
 * @throws If the existing JSON cannot be read or the replacement cannot be written.
 */
export function saveCommunityAccount(account: CommunityAccount | null): void {
  const { home, configJson } = getConfigPaths()
  if (!fs.existsSync(home)) {
    fs.mkdirSync(home, { recursive: true })
  }
  let current: Record<string, unknown> = {}
  if (fs.existsSync(configJson)) {
    const parsed: unknown = JSON.parse(fs.readFileSync(configJson, 'utf8'))
    if (!isRecord(parsed)) throw new Error('Desktop configuration must be a JSON object')
    current = parsed
  }
  if (account) {
    current.community = account
  } else {
    delete current.community
  }
  current.updatedAt = new Date().toISOString()
  const temporary = `${configJson}.${randomUUID()}.tmp`
  const descriptor = fs.openSync(temporary, 'wx', 0o600)
  try {
    try { fs.writeFileSync(descriptor, JSON.stringify(current, null, 2) + '\n', 'utf8') }
    finally { fs.closeSync(descriptor) }
    fs.renameSync(temporary, configJson)
  } catch (error) {
    fs.rmSync(temporary, { force: true })
    throw error
  }
}

/**
 * Sign in and persist a valid community session exclusively in the main process.
 * @param emailOrUsername - User-entered community identity.
 * @param password - User-entered password, sent only to the community HTTPS origin.
 * @param request - Instance-local Fetch adapter for deterministic network tests.
 * @returns A main-only outcome with fixed failure codes; failed sign-in preserves existing configuration.
 */
export async function loginCommunityAccount(
  emailOrUsername: string, password: string, request: typeof globalThis.fetch = globalThis.fetch,
): Promise<{ success: true; token: string } | { success: false; problem: CommunityLoginProblem }> {
  let response: Response
  try {
    response = await request('https://deepseek.stream/api/auth/login', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000), credentials: 'omit',
      headers: { 'content-type': 'application/json', 'user-agent': 'DeepSeek-Harness-Community', origin: 'https://deepseek.stream' },
      body: JSON.stringify({ emailOrUsername, password }),
    })
  } catch (_error) {
    // Transport errors contain private request details and never cross product IPC.
    return { success: false, problem: { code: 'login-network-failed' } }
  }
  if (!response.ok) {
    try { await response.body?.cancel() }
    catch (_error) { /* The HTTP status remains available when cancelling its body fails. */ }
    const code = response.status === 401 ? 'login-invalid-credentials'
      : response.status === 403 ? 'login-forbidden'
        : response.status === 429 ? 'login-rate-limited'
          : response.status === 400 ? 'invalid-account' : 'login-server-failed'
    return { success: false, problem: { code } }
  }
  let account: CommunityAccount
  try {
    const reader = response.body?.getReader()
    if (reader === undefined) return { success: false, problem: { code: 'login-invalid-response' } }
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        let next: ReadableStreamReadResult<Uint8Array>
        try { next = await reader.read() }
        catch (_error) { return { success: false, problem: { code: 'login-network-failed' } } }
        if (next.done) break
        size += next.value.byteLength
        if (size > 1024 * 1024) throw new Error('Community login response is too large')
        chunks.push(next.value)
      }
    } finally {
      try { await reader.cancel() }
      catch (_error) { /* The bounded response has already been read or rejected. */ }
    }
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!isRecord(data) || data.success !== true || !isRecord(data.user)) return { success: false, problem: { code: 'login-invalid-response' } }
    const cookie = response.headers.getSetCookie()
      .map(value => /(?:^|;\s*)deepseek_hub_auth_token=([^;]+)/u.exec(value)?.[1]).find(value => value !== undefined)
    const token = cookie ?? (typeof data.token === 'string' ? data.token : '')
    const candidate: unknown = {
      userId: typeof data.user.id === 'string' ? data.user.id
        : typeof data.user.id === 'number' && Number.isFinite(data.user.id) ? String(data.user.id) : '',
      username: typeof data.user.username === 'string' ? data.user.username : emailOrUsername,
      email: typeof data.user.email === 'string' ? data.user.email : '',
      token, savedAt: Date.now(),
      ...(typeof data.user.role === 'string' ? { role: data.user.role } : {}),
    }
    if (!isCommunityAccount(candidate) || candidate.userId === '') return { success: false, problem: { code: 'login-invalid-response' } }
    account = candidate
  } catch (_error) {
    // Invalid JSON, oversized replies, and malformed account metadata are not login credentials failures.
    return { success: false, problem: { code: 'login-invalid-response' } }
  }
  try {
    saveCommunityAccount(account)
  } catch (_error) {
    return { success: false, problem: { code: 'login-storage-failed' } }
  }
  return { success: true, token: account.token }
}

export function logoutCommunityAccount(): void {
  saveCommunityAccount(null)
}
