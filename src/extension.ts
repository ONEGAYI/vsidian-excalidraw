import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import {
  commands, env, extensions, Position, Range, TabInputCustom, TabInputText, Uri, window, workspace, WorkspaceEdit,
  type Disposable, type ExtensionContext, type TextDocument, type WebviewPanel,
} from 'vscode'
import { localResource, readAssets } from './assets.ts'
import { isDrawing, newDrawing, readDrawing, writeDrawing } from './format.ts'
import type { Message, Request } from './protocol.ts'
import { strings } from './strings.ts'

const BOARD = 'onegayi.vsidian-excalidraw.board'
const MARKDOWN = 'onegayi.vsidian.editor'
const HOST = 'onegayi.vsidian'

type Vsidian = {
  registerAddon(owner: { id: string }, definition: {
    enable(ctx: { onDispose(callback: () => void): void }): void
  }): { ok: true; dispose(): void } | { ok: false; reason: string }
}

export async function activate(context: ExtensionContext) {
  const words = strings(env.language)
  const host = extensions.getExtension<Vsidian>(HOST)
  if (!host) throw new Error('Vsidian is not available in this extension host')
  const api = await host.activate()
  let enabled = false
  const boards = new Set<() => void>()
  const output = window.createOutputChannel('Vsidian Excalidraw')
  const report = (error: unknown) => output.appendLine(error instanceof Error ? error.stack ?? error.message : String(error))

  function activeUri() {
    const input = window.tabGroups.activeTabGroup.activeTab?.input
    return input instanceof TabInputCustom || input instanceof TabInputText ? input.uri : undefined
  }
  function syncTitle() {
    const uri = activeUri()
    const doc = uri && workspace.textDocuments.find(item => item.uri.toString() === uri.toString())
    void commands.executeCommand('setContext', 'vsidianExcalidraw.canOpen', enabled && !!doc && isDrawing(doc.getText()))
  }

  async function resolveCustomTextEditor(document: TextDocument, panel: WebviewPanel) {
    panel.title = posix.basename(document.uri.path) + ' · ' + words.board
    const root = Uri.joinPath(context.extensionUri, 'dist', 'board')
    panel.webview.options = { enableScripts: true, localResourceRoots: [root] }
    const uri = (file: string) => panel.webview.asWebviewUri(Uri.joinPath(root, file)).toString()
    const nonce = randomUUID()
    const origin = panel.webview.cspSource
    panel.webview.html = `<!doctype html>
<html lang="${env.language.startsWith('zh') ? 'zh-CN' : 'en'}"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' ${origin}; style-src ${origin} 'unsafe-inline'; font-src ${origin} data:; img-src ${origin} data: blob:; connect-src ${origin} data: blob:; worker-src ${origin} blob:;">
<link rel="stylesheet" href="${uri('board.css')}">
<script nonce="${nonce}">window.EXCALIDRAW_ASSET_PATH=${JSON.stringify(uri(''))};window.boardLocale=${JSON.stringify(env.language)};</script>
</head><body><div id="root"></div><script nonce="${nonce}" type="module" src="${uri('board.js')}"></script></body></html>`

    let ready = false
    let applying: string | undefined
    let sequence = Promise.resolve()
    const post = (message: Message) => panel.webview.postMessage(message)
    let disposed = false
    async function publish(force = false) {
      if (disposed || !ready) return
      const version = document.version
      const state: Message = { kind: 'state', version, dirty: document.isDirty, enabled, missing: [], force }
      if (enabled) {
        try {
          const drawing = readDrawing(document.getText())
          const assets = await readAssets(document.uri, drawing.scene, drawing.attachments, report)
          state.scene = { ...drawing.scene, files: assets.files }
          state.missing = assets.missing
        } catch (error) {
          report(error)
        }
      }
      if (!disposed && document.version === version && enabled === state.enabled) await post(state)
    }
    const refresh = () => { void publish() }
    boards.add(refresh)

    const accept = async (msg: Request) => {
      switch (msg.kind) {
        case 'ready':
          ready = true
          await publish(true)
          return
        case 'reload': {
          const choice = await window.showWarningMessage(words.discard, { modal: true }, words.reload)
          if (choice === words.reload) await publish(true)
          return
        }
        case 'markdown':
          await commands.executeCommand('vscode.openWith', document.uri, MARKDOWN, { viewColumn: panel.viewColumn, preview: false })
          break
        case 'link': {
          if (!enabled) return
          if (/^https?:\/\//i.test(msg.link)) {
            await env.openExternal(Uri.parse(msg.link, true))
          } else {
            const wikilink = /^\[\[([^#|\]]+)(?:[#|][^\]]*)?\]\]$/.exec(msg.link)
            if (wikilink) {
              const path = wikilink[1]
              const found = await localResource(document.uri, /\.md$/i.test(path) ? path : path + '.md')
              if (found) await commands.executeCommand('vscode.openWith', found, MARKDOWN)
            }
          }
          return
        }
        default:
          if (!enabled) {
            await post({ kind: 'result', id: msg.id, version: document.version, reason: 'disabled' })
            return
          }
          switch (msg.kind) {
            case 'patch': {
              if (msg.version !== document.version) {
                await post({ kind: 'result', id: msg.id, version: document.version, reason: 'conflict' })
                return
              }
              const text = document.getText()
              const edits = writeDrawing(text, msg.patch).sort((a, b) => b.from - a.from || b.to - a.to)
              if (edits.length) {
                const edit = new WorkspaceEdit()
                let expected = text
                for (const { from, to, text: value } of edits) {
                  expected = expected.slice(0, from) + value + expected.slice(to)
                  edit.replace(document.uri, new Range(document.positionAt(from), document.positionAt(to)), value)
                }
                applying = expected
                try {
                  if (!await workspace.applyEdit(edit)) throw new Error('VS Code rejected the drawing edit')
                } finally {
                  applying = undefined
                }
              }
              break
            }
            case 'save':
              if (!await document.save()) throw new Error('VS Code could not save the drawing')
              break
            case 'undo':
            case 'redo':
              if (!panel.active) {
                void window.showWarningMessage(words.inactive)
                await post({ kind: 'result', id: msg.id, version: document.version, reason: 'inactive' })
                return
              }
              await commands.executeCommand(msg.kind)
              break
          }
      }
      await post({ kind: 'result', id: msg.id, version: document.version })
    }

    const subscriptions = [
      panel.webview.onDidReceiveMessage((msg: Request) => {
        sequence = sequence.then(async () => {
          if (!disposed) await accept(msg)
        }).catch(async error => {
          report(error)
          if ('id' in msg) {
            const reason = error instanceof Error && error.message === 'reserved-text' ? 'reservedText' : 'deleted'
            await post({ kind: 'result', id: msg.id, version: document.version, reason })
          }
        })
      }),
      workspace.onDidChangeTextDocument(event => {
        if (event.document !== document) return
        if (!event.contentChanges.length || document.getText() === applying) {
          if (ready) void post({ kind: 'status', dirty: document.isDirty })
        } else {
          void publish()
        }
      }),
      workspace.onDidSaveTextDocument(saved => {
        if (saved === document && ready) void post({ kind: 'status', dirty: saved.isDirty })
      }),
    ]
    panel.onDidDispose(() => {
      disposed = true
      boards.delete(refresh)
      for (const sub of subscriptions) sub.dispose()
    })
  }

  const addon = api.registerAddon(context.extension, {
    enable({ onDispose }) {
      enabled = true
      void commands.executeCommand('setContext', 'vsidianExcalidraw.enabled', true)
      syncTitle()
      for (const refresh of boards) refresh()
      onDispose(() => {
        enabled = false
        void commands.executeCommand('setContext', 'vsidianExcalidraw.enabled', false)
        syncTitle()
        for (const refresh of boards) refresh()
      })
    },
  })
  if (!addon.ok) throw new Error('Vsidian rejected Excalidraw: ' + addon.reason)

  const subscriptions: Disposable[] = [
    addon, output,
    window.registerCustomEditorProvider(BOARD, { resolveCustomTextEditor }, { webviewOptions: { retainContextWhenHidden: true } }),
    window.tabGroups.onDidChangeTabs(syncTitle),
    window.tabGroups.onDidChangeTabGroups(syncTitle),
    workspace.onDidOpenTextDocument(syncTitle),
    workspace.onDidChangeTextDocument(event => {
      if (event.document.uri.toString() === activeUri()?.toString()) syncTitle()
    }),
    commands.registerCommand('vsidianExcalidraw.open', async (resource?: Uri) => {
      if (!enabled) return window.showWarningMessage(words.disabled)
      const uri = resource ?? activeUri()
      if (!uri || !/\.md$/i.test(uri.path)) return window.showWarningMessage(words.notDrawing)
      const document = await workspace.openTextDocument(uri)
      if (!isDrawing(document.getText())) return window.showWarningMessage(words.notDrawing)
      await commands.executeCommand('vscode.openWith', uri, BOARD, { preview: false })
    }),
    commands.registerCommand('vsidianExcalidraw.create', async () => {
      if (!enabled) return window.showWarningMessage(words.disabled)
      const folder = workspace.workspaceFolders?.[0]?.uri
      const uri = await window.showSaveDialog({
        title: words.createTitle,
        defaultUri: folder && Uri.joinPath(folder, 'Drawing.excalidraw.md'),
        filters: { Markdown: ['md'] },
      })
      if (!uri) return
      if (!/\.md$/i.test(uri.path)) return window.showWarningMessage(words.markdownPath)
      try {
        const edit = new WorkspaceEdit()
        edit.createFile(uri)
        edit.insert(uri, new Position(0, 0), newDrawing())
        if (!await workspace.applyEdit(edit)) throw new Error('VS Code rejected the new drawing')
        const document = await workspace.openTextDocument(uri)
        if (!await document.save()) throw new Error('VS Code could not save the new drawing')
        await commands.executeCommand('vscode.openWith', uri, BOARD, { preview: false })
      } catch (error) {
        report(error)
        void window.showErrorMessage(words.createFailed)
      }
    }),
  ]
  context.subscriptions.push(...subscriptions)
  syncTitle()
}
