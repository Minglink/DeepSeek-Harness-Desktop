import { describe, it, expect } from 'vitest'
import { parseDshProtocolUrl } from '../src/main/protocol.ts'

describe('dsh:// protocol parser', () => {
  it('parses basic installation request', () => {
    const url = 'dsh://plugin/install?id=open-design&name=打开%20Design&version=1.0.0&repo=nexu-io/open-design'
    const result = parseDshProtocolUrl(url)

    expect(result).not.toBeNull()
    expect(result?.id).toBe('open-design')
    expect(result?.name).toBe('打开 Design')
    expect(result?.version).toBe('1.0.0')
    expect(result?.repo).toBe('nexu-io/open-design')
    expect(result?.permissions).toEqual(['常规运行权限'])
    expect(result?.downloadUrl).toBeUndefined()
  })

  it('parses full url with permissions and downloadUrl', () => {
    const url = 'dsh://plugin/install?id=latex-ocr&name=LaTeX%20%E5%85%AC%E5%BC%8F%E8%AF%86%E5%88%AB&version=1.2.0&repo=deepseek-community/latex-ocr&permissions=%E7%BD%91%E7%BB%9C%E8%AF%B7%E6%B1%82%2C%E6%9C%AC%E5%9C%B0%E6%96%87%E4%BB%B6%E8%AF%BB%E5%86%99&downloadUrl=https%3A%2F%2Fapi.deepseek.com%2Fplugins%2Flatex-ocr-1.2.0.zip'
    const result = parseDshProtocolUrl(url)

    expect(result).not.toBeNull()
    expect(result?.id).toBe('latex-ocr')
    expect(result?.name).toBe('LaTeX 公式识别')
    expect(result?.version).toBe('1.2.0')
    expect(result?.repo).toBe('deepseek-community/latex-ocr')
    expect(result?.permissions).toEqual(['网络请求', '本地文件读写'])
    expect(result?.downloadUrl).toBe('https://api.deepseek.com/plugins/latex-ocr-1.2.0.zip')
  })

  it('handles variations like dsh:plugin/install', () => {
    const url = 'dsh:plugin/install?id=my-plugin&repo=@deepseek-ai/dsh-my-plugin'
    const result = parseDshProtocolUrl(url)

    expect(result).not.toBeNull()
    expect(result?.id).toBe('my-plugin')
    expect(result?.repo).toBe('@deepseek-ai/dsh-my-plugin')
  })

  it('returns null for non-dsh urls or wrong routes', () => {
    expect(parseDshProtocolUrl('https://example.com')).toBeNull()
    expect(parseDshProtocolUrl('dsh://other/route')).toBeNull()
    expect(parseDshProtocolUrl('')).toBeNull()
  })
})
