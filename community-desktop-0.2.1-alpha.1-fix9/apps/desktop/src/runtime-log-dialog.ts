/** Native client diagnostics remain accessible when the application document fails to boot. */
import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron'
import type { DesktopMessages } from './locale.ts'

const PREVIEW_CHARACTERS = 16_000

interface RuntimeLogDialogOperations {
  messages(): DesktopMessages
  read(): Promise<string>
  show(options: MessageBoxOptions): Promise<MessageBoxReturnValue>
  copy(text: string): Promise<void>
  export(text: string): Promise<boolean>
}

/** One native viewer owns its dialogs and joins repeated menu or recovery requests. */
export class DesktopRuntimeLogDialog {
  private pending: Promise<void> | undefined

  /** @param operations - Main-owned sanitized history and native presentation/copy/export operations. */
  constructor(private readonly operations: RuntimeLogDialogOperations) {}

  /** @returns When the viewer closes; repeated requests join the same operation. */
  show(): Promise<void> {
    return this.pending ??= this.run().finally(() => { this.pending = undefined })
  }

  private async run(): Promise<void> {
    const messages = this.operations.messages()
    let status = messages.runtimeLogDescription
    for (;;) {
      let text: string
      try { text = await this.operations.read() }
      catch (_error) {
        const { response } = await this.operations.show({ type: 'error', title: messages.runtimeLogTitle,
          message: messages.runtimeLogReadFailed, buttons: [messages.runtimeLogBack, messages.runtimeLogRefresh],
          defaultId: 0, cancelId: 0, noLink: true })
        if (response !== 1) return
        continue
      }
      const notice = `${messages.runtimeLogPreviewTruncated}\n\n`
      const detail = text.length <= PREVIEW_CHARACTERS ? text
        : notice + text.slice(-(PREVIEW_CHARACTERS - notice.length)).replace(/^[\uDC00-\uDFFF]/u, '')
      const { response } = await this.operations.show({ type: 'info', title: messages.runtimeLogTitle,
        message: status, detail, buttons: [messages.runtimeLogBack, messages.runtimeLogCopy, messages.runtimeLogExport],
        defaultId: 0, cancelId: 0, noLink: true })
      if (response === 0) return
      if (response === 1) {
        try { await this.operations.copy(text); status = messages.runtimeLogCopied }
        catch (_error) { status = messages.runtimeLogCopyFailed }
      } else if (response === 2) {
        try { status = await this.operations.export(text) ? messages.runtimeLogExported : messages.runtimeLogExportCancelled }
        catch (_error) { status = messages.runtimeLogExportFailed }
      }
    }
  }
}
