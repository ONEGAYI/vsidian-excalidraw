import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { setImmediate as turn } from 'node:timers/promises'

test('画板只读取最新待发版本，停用不等附件读取完毕，并准确报告图片拒绝', async () => {
  const mock = 'data:text/javascript,' + encodeURIComponent(`
    import { posix } from 'node:path'
    const subscription = { dispose() {} }
    export const io = { reads: 0, pending: Promise.resolve(), errors: [] }
    export const callbacks = { changes: [] }
    export class FileSystemError extends Error {}
    export class RelativePattern {}
    export class Position {}
    export class Range {}
    export class TabInputCustom {}
    export class TabInputText {}
    export class WorkspaceEdit {}
    export const Uri = { joinPath: (base, ...parts) => ({ path: posix.join(base.path, ...parts) }) }
    export const commands = { executeCommand() {}, registerCommand: () => subscription }
    export const env = { language: 'en' }
    const enable = definition => definition.enable({
      pages: { registerEditor() {} }, channel: { handle() {} },
      onDispose: callback => { callbacks.disable = callback },
    })
    export const extensions = { getExtension: () => ({ activate: () => ({
      registerAddon(owner, definition) {
        callbacks.enable = () => enable(definition)
        callbacks.enable()
        return { ok: true, dispose() {} }
      },
    }) }) }
    export const window = {
      createOutputChannel: () => ({ appendLine: message => io.errors.push(message) }),
      registerCustomEditorProvider(view, provider) {
        callbacks.open = provider.resolveCustomTextEditor
        return subscription
      },
      tabGroups: { all: [], activeTabGroup: {}, onDidChangeTabs: () => subscription, onDidChangeTabGroups: () => subscription },
    }
    export const workspace = {
      onDidOpenTextDocument: () => subscription, onDidSaveTextDocument: () => subscription,
      onDidChangeTextDocument: callback => { callbacks.changes.push(callback); return subscription },
      getWorkspaceFolder: () => ({ uri: { path: '/vault' } }),
      fs: {
        stat: async () => ({ size: 3 }),
        readFile: async () => { io.reads++; await io.pending; return new Uint8Array([1, 2, 3]) },
      },
    }
  `)
  const hooks = registerHooks({
    resolve: (specifier, context, next) => specifier === 'vscode'
      ? { url: mock, shortCircuit: true } : next(specifier, context),
  })
  try {
    const { activate } = await import('../src/extension.ts')
    const { callbacks, io } = await import('vscode')
    await activate({ extension: { id: 'test.addon' }, extensionUri: { path: '/extension' }, subscriptions: [] })
    const scene = { type: 'excalidraw', version: 2, elements: [{ type: 'image', id: 'SOURCE01', fileId: 'page' }] }
    const document = { uri: { path: '/vault/drawing.md' }, version: 1, isDirty: false,
      getText: () => ['---', 'excalidraw-plugin: parsed', '---', '# Excalidraw Data', '## Embedded Files',
        'page: [[pages.pdf#page=2]]', '## Drawing', '```json', JSON.stringify(scene), '```'].join('\n') }
    const states = []
    const results = []
    let receive
    await callbacks.open(document, {
      webview: {
        cspSource: 'test', asWebviewUri: uri => uri.path, postMessage: async message => {
          if (message.kind === 'state') states.push([message.version, message.force, message.enabled])
          if (message.kind === 'result') results.push(message)
          return true
        },
        onDidReceiveMessage: callback => { receive = callback; return { dispose() {} } },
      },
      onDidDispose() {},
    })
    const edit = version => {
      document.version = version
      for (const changed of callbacks.changes) changed({ document, contentChanges: [{}] })
    }
    let gate = Promise.withResolvers()
    io.pending = gate.promise
    receive({ kind: 'ready' })
    await turn()
    assert.equal(io.reads, 1)
    for (const version of [2, 3, 4]) edit(version)
    await turn()
    assert.equal(io.reads, 1, 'a pending attachment read must not start parallel snapshots')
    gate.resolve()
    await turn()
    assert.equal(io.reads, 2)
    assert.deepEqual(states, [[4, true, true]], 'only the newest version arrives, retaining forced initialization')

    gate = Promise.withResolvers()
    io.pending = gate.promise
    edit(5)
    await turn()
    callbacks.disable()
    await turn()
    assert.deepEqual(states.at(-1), [5, false, false], 'disabling the board is immediate')
    callbacks.enable()
    await turn()
    assert.equal(io.reads, 3)
    gate.resolve()
    await turn()
    assert.equal(io.reads, 4)
    assert.deepEqual(states, [[4, true, true], [5, false, false], [5, false, true]])
    assert.deepEqual(io.errors, [])

    const id = '0'.repeat(32)
    receive({ kind: 'patch', id: 1, version: 5, images: [{ id, dataURL: '' }],
      patch: { elements: [{ id: 'IMAGE001', fields: { type: 'image', fileId: id } }] } })
    await turn()
    assert.deepEqual(results, [{ kind: 'result', id: 1, version: 5, reason: 'imageRejected' }])
    assert.equal(io.errors.length, 1)
    assert.match(io.errors[0], /^Error: invalid-image-import/)
  } finally {
    hooks.deregister()
  }
})
