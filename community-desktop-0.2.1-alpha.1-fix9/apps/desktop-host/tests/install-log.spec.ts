/** Package output retains its task identity on private Host IPC before profile loading. */
import { Context } from '@deepseek-ai/cordis'
import type { PluginInstallLogChunk, PluginInstallRequestId } from '@deepseek-ai/dsh-plugin-manager/types'
import { describe, expect, it, vi } from 'vitest'
import { installDesktopInstallLog } from '../src/install-log.ts'

describe('Desktop native installation output', () => {
  it('splits oversized output without losing Unicode or attaching exit before its last frame', () => {
    const ctx = new Context(), frames: PluginInstallLogChunk[] = []
    installDesktopInstallLog(ctx, (chunk) => { frames.push(chunk) })
    const text = 'x'.repeat(65_535) + '🚀中文' + 'y'.repeat(65_536) + '最后尾'
    const chunk: PluginInstallLogChunk = { requestId: 'main-task' as PluginInstallRequestId,
      jobId: 'pnpm-run', argv: ['pnpm', 'add'], cwd: 'C:/owned/profile', stream: 'stderr', text, exitCode: 7 }
    ctx.emit('plugin-manager/install-log', chunk)
    expect(frames).toHaveLength(3)
    expect(frames.map(frame => frame.text).join('')).toBe(text)
    expect(frames.every(frame => frame.text.length <= 65_536 && !/[\uD800-\uDBFF]$/u.test(frame.text))).toBe(true)
    expect(frames.slice(0, -1).every(frame => frame.exitCode === undefined)).toBe(true)
    expect(frames.at(-1)?.exitCode).toBe(7)
    expect(frames.every(frame => frame.jobId === chunk.jobId && frame.requestId === chunk.requestId)).toBe(true)
  })

  it('forwards both streams, original command fields and terminal exit without changing output', () => {
    const ctx = new Context()
    const send = vi.fn()
    installDesktopInstallLog(ctx, send)
    const chunk: PluginInstallLogChunk = { requestId: 'task-fixture' as PluginInstallRequestId,
      jobId: 'pnpm-fixture', argv: ['pnpm', 'add', 'fixture@file:C:/fixture.tgz'], cwd: 'C:/owned/profile',
      stream: 'stdout', text: '安装完成\n' }
    ctx.emit('plugin-manager/install-log', chunk)
    ctx.emit('plugin-manager/install-log', { ...chunk, stream: 'stderr', text: 'warning\n', exitCode: 1 })
    expect(send.mock.calls).toEqual([[chunk], [{ ...chunk, stream: 'stderr', text: 'warning\n', exitCode: 1 }]])
  })

  it('contains sender failures and leaves other event observers running', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const ctx = new Context(), later = vi.fn()
      installDesktopInstallLog(ctx, () => { throw new Error('IPC refused') })
      ctx.on('plugin-manager/install-log', later)
      const chunk: PluginInstallLogChunk = { jobId: 'run', argv: [], cwd: 'C:/fixture', stream: 'stdout', text: '' }
      expect(() => { ctx.emit('plugin-manager/install-log', chunk) }).not.toThrow()
      expect(later).toHaveBeenCalledWith(chunk)
      expect(error).toHaveBeenCalledWith('Desktop installation log forwarding failed')
    } finally { error.mockRestore() }
  })
})
