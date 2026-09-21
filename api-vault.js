import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import https from 'node:https'
import http from 'node:http'

export function getDshHome() {
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

export function readConfig() {
  const { configJson, credentialsYaml } = getConfigPaths()

  let apiKey = process.env.DEEPSEEK_API_KEY || ''
  let baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'
  let aiModel = process.env.DEEPSEEK_MODEL || 'deepseek-chat'

  if (fs.existsSync(configJson)) {
    try {
      const data = JSON.parse(fs.readFileSync(configJson, 'utf8'))
      if (data.apiKey) apiKey = data.apiKey
      if (data.baseUrl) baseUrl = data.baseUrl
      if (data.aiModel) aiModel = data.aiModel
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

  return { apiKey, baseUrl, aiModel }
}

export function hasValidApiKey() {
  const { apiKey } = readConfig()
  return typeof apiKey === 'string' && apiKey.trim().length >= 10
}

export function saveConfig({ apiKey, baseUrl, aiModel }) {
  const { home, configJson, credentialsYaml, envFile } = getConfigPaths()

  if (!fs.existsSync(home)) {
    fs.mkdirSync(home, { recursive: true })
  }

  const cleanKey = (apiKey || '').trim()
  const cleanUrl = (baseUrl || 'https://api.deepseek.com').trim().replace(/\/+$/, '')
  const cleanModel = (aiModel || 'deepseek-chat').trim()

  // 1. Write desktop-config.json
  const configData = {
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
  // In dsh-app-boot, DEEPSEEK_BASE_URL is strictly prohibited in .env and causes boot crash (exit 1).
  // It is supplied directly via process.env by the desktop parent launcher.
  if (cleanKey) {
    fs.writeFileSync(envFile, `DEEPSEEK_API_KEY=${cleanKey}\n`, 'utf8')
  } else if (fs.existsSync(envFile)) {
    try { fs.unlinkSync(envFile) } catch {}
  }

  // 4. Update current runtime environment variables (launcher process environment)
  process.env.DEEPSEEK_API_KEY = cleanKey
  process.env.DEEPSEEK_BASE_URL = cleanUrl
  process.env.DEEPSEEK_MODEL = cleanModel

  return true
}

export function testApiConnection(apiKey, baseUrl = 'https://api.deepseek.com') {
  return new Promise((resolve) => {
    try {
      const cleanKey = (apiKey || '').trim()
      const cleanUrl = (baseUrl || 'https://api.deepseek.com').trim().replace(/\/+$/, '')
      const targetUrl = new URL(`${cleanUrl}/models`)

      const client = targetUrl.protocol === 'https:' ? https : http
      const options = {
        hostname: targetUrl.hostname,
        port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
        path: targetUrl.pathname,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${cleanKey}`,
          'User-Agent': 'DeepSeek-Harness-Desktop/0.1.3-max',
          'Accept': 'application/json',
        },
        timeout: 10000,
      }

      const req = client.request(options, (res) => {
        let body = ''
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ ok: true, statusCode: res.statusCode })
          } else if (res.statusCode === 401) {
            resolve({ ok: false, error: 'API Key 认证失败，密钥不正确或已失效 (401)' })
          } else {
            resolve({ ok: false, error: `服务器返回状态码 ${res.statusCode}: ${body.slice(0, 100)}` })
          }
        })
      })

      req.on('error', (err) => {
        resolve({ ok: false, error: `网络请求失败: ${err.message}` })
      })

      req.on('timeout', () => {
        req.destroy()
        resolve({ ok: false, error: '连接超时 (10 秒)，请检查网络或代理设置' })
      })

      req.end()
    } catch (err) {
      resolve({ ok: false, error: `请求格式错误: ${err.message}` })
    }
  })
}

/**
 * 实时调用 DeepSeek 官方或用户自定义的大模型 API
 * 用于一键安装过程中的非标/旧版插件智能分析、代码重构与运行时自愈。
 */
export function callDeepSeekChat({ messages, systemPrompt, temperature = 0.2, maxTokens = 4096 }) {
  return new Promise((resolve) => {
    try {
      const { apiKey, baseUrl, aiModel } = readConfig()
      const cleanKey = (apiKey || '').trim()
      if (!cleanKey) {
        return resolve({ ok: false, error: '未配置 DeepSeek API Key，请先配置密钥' })
      }
      const cleanUrl = (baseUrl || 'https://api.deepseek.com').trim().replace(/\/+$/, '')
      const targetModel = aiModel || 'deepseek-chat'

      const targetUrl = new URL(`${cleanUrl}/chat/completions`)
      const client = targetUrl.protocol === 'https:' ? https : http

      const payload = {
        model: targetModel,
        messages: [
          ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
          ...(messages || [])
        ],
        temperature: typeof temperature === 'number' ? temperature : 0.2,
        max_tokens: typeof maxTokens === 'number' ? maxTokens : 4096
      }

      const postData = JSON.stringify(payload)
      const options = {
        hostname: targetUrl.hostname,
        port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
        path: targetUrl.pathname + (targetUrl.search || ''),
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${cleanKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          'User-Agent': 'DeepSeek-Harness-Desktop/0.1.6-max',
          'Accept': 'application/json',
        },
        timeout: 45000,
      }

      const req = client.request(options, (res) => {
        let body = ''
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = JSON.parse(body)
              const content = parsed.choices?.[0]?.message?.content || ''
              resolve({ ok: true, content, model: parsed.model || targetModel })
            } catch (jsonErr) {
              resolve({ ok: false, error: `解析 API 响应失败: ${jsonErr.message}`, rawBody: body })
            }
          } else {
            resolve({ ok: false, error: `DeepSeek API 返回 HTTP ${res.statusCode}: ${body.slice(0, 300)}` })
          }
        })
      })

      req.on('error', (err) => {
        resolve({ ok: false, error: `网络请求失败: ${err.message}` })
      })

      req.on('timeout', () => {
        req.destroy()
        resolve({ ok: false, error: 'DeepSeek API 调用超时 (45 秒)，请检查网络连接' })
      })

      req.write(postData)
      req.end()
    } catch (err) {
      resolve({ ok: false, error: `请求构建异常: ${err.message}` })
    }
  })
}
