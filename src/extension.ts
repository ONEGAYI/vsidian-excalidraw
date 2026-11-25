import { randomUUID } from 'node:crypto'
import { isAbsolute, posix } from 'node:path'
import {
  commands, env, extensions, Position, Range, TabInputCustom, TabInputText, Uri, window, workspace, WorkspaceEdit,
  type Disposable, type ExtensionContext, type Tab, type TextDocument, type ViewColumn, type WebviewPanel,
} from 'vscode'
import { localResource, readAssets, stageImportedImages } from './assets.ts'
import { isDrawing, newDrawing, readDrawing, writeDrawing } from './format.ts'
import { localReference } from './references.ts'
import type { Message, Request } from './protocol.ts'
import { strings } from './strings.ts'
import { allowedWebOrigins, webLink } from './web.ts'

const BOARD = 'onegayi.vsidian-excalidraw.board'
const MARKDOWN = 'onegayi.vsidian.editor'
const HOST = 'onegayi.vsidian'

type Vsidian = {
  registerAddon(owner: { id: string }, definition: {
    setup(ctx: { settings: {
      registerDefinitions(definitions: readonly unknown[]): Disposable
      get(): { values: Readonly<Record<string, unknown>> }
      onChanged(callback: () => void): Disposable
    } }): void
    enable(ctx: {
      pages: { registerEditor(entry: { entry: string; resources: string[] }): Disposable }
      channel: { handle(topic: string, handler: (payload: unknown) => unknown): Disposable }
      onDispose(callback: () => void): void
    }): void
  }): { ok: true; dispose(): void } | { ok: false; reason: string }
}

export async function activate(context: ExtensionContext) {
  const words = strings(env.language)
  const host = extensions.getExtension<Vsidian>(HOST)
  if (!host) throw new Error('Vsidian is not available in this extension host')
  const api = await host.activate()
  let enabled = false
  let webOrigins: string[] = []
  const boards = new Set<() => void>()
  const webPolicies = new Set<() => void>()
  const examinedTabs = new WeakSet<Tab>()
  const openingMarkdown = new Set<string>()
  const output = window.createOutputChannel('Vsidian Excalidraw')
  const report = (error: unknown) => output.appendLine(error instanceof Error ? error.stack ?? error.message : String(error))

  function tabUri(tab: Tab | undefined) {
    const input = tab?.input
    return input instanceof TabInputCustom || input instanceof TabInputText ? input.uri : undefined
  }

  const markdownKey = (uri: Uri, column: ViewColumn) => column + ':' + uri.toString()

  async function openMarkdown(uri: Uri, viewColumn: ViewColumn) {
    const key = markdownKey(uri, viewColumn)
    openingMarkdown.add(key)
    try {
      await commands.executeCommand('vscode.openWith', uri, MARKDOWN, { viewColumn, preview: false })
      const tab = window.tabGroups.all.find(group => group.viewColumn === viewColumn)?.activeTab
      if (tab?.input instanceof TabInputCustom && tab.input.viewType === MARKDOWN
        && tab.input.uri.toString() === uri.toString()) examinedTabs.add(tab)
    } finally {
      openingMarkdown.delete(key)
    }
  }

  async function closePreviousView(document: TextDocument, from: Tab, view: string) {
    const active = from.group.activeTab
    // Closing a dirty custom editor can revert the shared TextDocument.
    if (!document.isDirty && from.group.tabs.includes(from) && active !== from &&
      active?.input instanceof TabInputCustom && active.input.viewType === view &&
      active.input.uri.toString() === document.uri.toString()) await window.tabGroups.close(from)
  }

  async function openBoard(document: TextDocument, from?: Tab) {
    await commands.executeCommand('vscode.openWith', document.uri, BOARD, { viewColumn: from?.group.viewColumn, preview: false })
    if (from) await closePreviousView(document, from, BOARD)
  }

  function syncTitle() {
    const tab = window.tabGroups.activeTabGroup.activeTab
    const uri = tabUri(tab)
    const doc = uri && workspace.textDocuments.find(item => item.uri.toString() === uri.toString())
    const drawing = enabled && !!doc && isDrawing(doc.getText())
    void commands.executeCommand('setContext', 'vsidianExcalidraw.canOpen', drawing)
    return { tab, doc, drawing }
  }

  function syncTab() {
    const { tab, doc, drawing } = syncTitle()
    if (!enabled || !doc || !(tab?.input instanceof TabInputCustom) || tab.input.viewType !== MARKDOWN || examinedTabs.has(tab)) return
    // Check each tab on first activation, not while the user edits its frontmatter.
    examinedTabs.add(tab)
    if (!drawing || openingMarkdown.has(markdownKey(doc.uri, tab.group.viewColumn))) return
    try {
      readDrawing(doc.getText())
    } catch (error) {
      report(error)
      return
    }
    void openBoard(doc, tab).catch(report)
  }

  async function resolveCustomTextEditor(document: TextDocument, panel: WebviewPanel) {
    panel.title = posix.basename(document.uri.path) + ' · ' + words.board
    const root = Uri.joinPath(context.extensionUri, 'dist', 'board')
    panel.webview.options = { enableScripts: true, localResourceRoots: [root] }
    const uri = (file: string) => panel.webview.asWebviewUri(Uri.joinPath(root, file)).toString()
    const nonce = randomUUID()
    const origin = panel.webview.cspSource
    const frameSources = new Set(webOrigins)
    panel.webview.html = `<!doctype html>
<html lang="${env.language.startsWith('zh') ? 'zh-CN' : 'en'}"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' ${origin} 'wasm-unsafe-eval'; style-src ${origin} 'unsafe-inline'; font-src ${origin} data:; img-src ${origin} data: blob:; connect-src ${origin} data: blob:; worker-src ${origin} blob:; frame-src ${[...frameSources].join(' ') || "'none'"};">
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
          state.references = assets.references
        } catch (error) {
          report(error)
        }
      }
      // Undo/redo can change dirty state while the scene's attachments are being read.
      if (!disposed && document.version === version && enabled === state.enabled) await post({ ...state, dirty: document.isDirty })
    }
    const refresh = () => { void publish() }
    const sendPolicy = () => ready && !disposed
      ? post({ kind: 'web-policy', origins: webOrigins.filter(origin => frameSources.has(origin)) }) : undefined
    const refreshPolicy = () => { void sendPolicy() }
    boards.add(refresh)
    webPolicies.add(refreshPolicy)

    const accept = async (msg: Request) => {
      switch (msg.kind) {
        case 'ready':
          ready = true
          await sendPolicy()
          await publish(true)
          return
        case 'reload': {
          const choice = await window.showWarningMessage(words.discard, { modal: true }, words.reload)
          if (choice === words.reload) await publish(true)
          return
        }
        case 'markdown': {
          const from = panel.active ? window.tabGroups.activeTabGroup.activeTab : undefined
          await openMarkdown(document.uri, panel.viewColumn ?? window.tabGroups.activeTabGroup.viewColumn)
          await post({ kind: 'result', id: msg.id, version: document.version })
          if (from && !msg.preserveBoard) await closePreviousView(document, from, MARKDOWN)
          return
        }
        case 'link': {
          if (!enabled) return
          const url = webLink(msg.link)
          if (url) {
            await env.openExternal(Uri.parse(url.href, true))
          } else {
            const target = localReference(msg.link, true)
            if (target) {
              const found = await localResource(document.uri, target.path)
              if (found && target.kind === 'note') await openMarkdown(found, window.tabGroups.activeTabGroup.viewColumn)
              if (found && target.kind === 'pdf') await commands.executeCommand('vscode.open', found.with({ fragment: target.fragment }))
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
              const images = msg.images ? stageImportedImages(document.uri, msg.images, msg.patch) : []
              const attachments = images.map(({ id, target }) => ({ id, target }))
              const edits = writeDrawing(text, { ...msg.patch, attachments }).sort((a, b) => b.from - a.from || b.to - a.to)
              if (edits.length) {
                const edit = new WorkspaceEdit()
                for (const image of images) edit.createFile(image.uri, { contents: image.bytes })
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
      webPolicies.delete(refreshPolicy)
      for (const sub of subscriptions) sub.dispose()
    })
  }

  const addon = api.registerAddon(context.extension, {
    setup({ settings }) {
      settings.registerDefinitions([{
        key: 'webPreviewOrigins', type: 'array', default: [], maxItems: 20,
        items: { kind: 'string', maxLength: 260 },
        title: words.webOriginsTitle, description: words.webOriginsDescription,
      }])
      const refresh = () => {
        webOrigins = allowedWebOrigins(settings.get().values.webPreviewOrigins)
        for (const notify of webPolicies) notify()
      }
      refresh()
      settings.onChanged(refresh)
    },
    enable({ pages, channel, onDispose }) {
      pages.registerEditor({ entry: 'dist/preview.js', resources: ['dist/board'] })
      for (const topic of ['drawing.preview', 'drawing.open']) {
        channel.handle(topic, async payload => {
          if (!payload || typeof payload !== 'object' || !('fsPath' in payload) ||
              typeof payload.fsPath !== 'string' || !isAbsolute(payload.fsPath) || !/\.md$/i.test(payload.fsPath)) return null
          const uri = Uri.file(payload.fsPath)
          if (topic === 'drawing.open') {
            await commands.executeCommand('vsidianExcalidraw.open', uri)
            return true
          }
          if (!('text' in payload) || typeof payload.text !== 'string' || !isDrawing(payload.text)) return null
          try {
            const drawing = readDrawing(payload.text)
            const assets = await readAssets(uri, drawing.scene, drawing.attachments, report)
            const { images, pdfs } = assets.references
            return { scene: { ...drawing.scene, files: assets.files }, references: { images, pdfs } }
          } catch (error) {
            report(error)
            return null
          }
        })
      }
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
    window.tabGroups.onDidChangeTabs(syncTab),
    window.tabGroups.onDidChangeTabGroups(syncTab),
    workspace.onDidOpenTextDocument(syncTab),
    workspace.onDidChangeTextDocument(event => {
      if (event.document.uri.toString() === tabUri(window.tabGroups.activeTabGroup.activeTab)?.toString()) syncTitle()
    }),
    commands.registerCommand('vsidianExcalidraw.open', async (resource?: Uri) => {
      if (!enabled) return window.showWarningMessage(words.disabled)
      const from = window.tabGroups.activeTabGroup.activeTab
      const uri = resource ?? tabUri(from)
      if (!uri || !/\.md$/i.test(uri.path)) return window.showWarningMessage(words.notDrawing)
      const document = await workspace.openTextDocument(uri)
      if (!isDrawing(document.getText())) return window.showWarningMessage(words.notDrawing)
      await openBoard(document, tabUri(from)?.toString() === uri.toString() ? from : undefined)
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
  syncTab()
}
