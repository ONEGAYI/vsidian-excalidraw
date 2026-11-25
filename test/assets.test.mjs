import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

test('同一个 PDF 的多个选页只传一份文件数据，并保留各自的页码和源链接', async () => {
  const vscode = 'data:text/javascript,' + encodeURIComponent(`
    import { posix } from 'node:path'
    export class FileSystemError extends Error {}
    export class RelativePattern {}
    export const reads = []
    export const Uri = { joinPath: (base, ...parts) => ({ path: posix.join(base.path, ...parts) }) }
    export const workspace = {
      getWorkspaceFolder: () => ({ uri: { path: '/vault' } }),
      fs: {
        stat: async () => ({ type: 1, size: 3 }),
        readFile: async file => {
          reads.push(file.path)
          return new Uint8Array([1, 2, 3])
        },
      },
    }
  `)
  const hooks = registerHooks({
    resolve: (specifier, context, next) => specifier === 'vscode'
      ? { url: vscode, shortCircuit: true } : next(specifier, context),
  })
  try {
    const { readAssets } = await import('../src/assets.ts?pdf')
    const { reads } = await import('vscode')
    const scene = { elements: [
      { id: 'image-one', type: 'image', fileId: 'page-one' },
      { id: 'image-two', type: 'image', fileId: 'page-two' },
      { id: 'card', type: 'embeddable', link: '[[pages.pdf#page=3]]' },
    ] }
    const paths = new Map([['page-one', 'pages.pdf#page=1'], ['page-two', './pages.pdf#page=2|100%']])
    const { references, missing } = await readAssets({ path: '/vault/drawing.md' }, scene, paths, assert.fail)
    assert.deepEqual(missing, [])
    assert.deepEqual(reads, ['/vault/pages.pdf'])
    assert.deepEqual(Object.values(references.pdfs), ['AQID'])
    assert.deepEqual([references.images['page-one'].page, references.images['page-two'].page, references.cards.card.page], [1, 2, 3])
    assert.equal(references.imageLinks['page-two'], '[[./pages.pdf#page=2]]')
  } finally {
    hooks.deregister()
  }
})

test('单张图片读失败时报告缺图，其他图片仍能显示', async () => {
  const vscode = 'data:text/javascript,' + encodeURIComponent(`
    import { posix } from 'node:path'
    export class FileSystemError extends Error {
      code = 'FileNotFound'
    }
    export class RelativePattern {}
    export const Uri = {
      joinPath: (base, part) => ({ path: posix.join(base.path, part) }),
    }
    export const workspace = {
      getWorkspaceFolder: () => ({ uri: { path: '/vault' } }),
      fs: {
        stat: async () => ({ type: 1 }),
        readFile: async file => {
          if (file.path.endsWith('removed.svg')) throw new FileSystemError(file.path)
          return new Uint8Array([1, 2, 3])
        },
      },
    }
  `)
  const hooks = registerHooks({
    resolve: (specifier, context, next) => specifier === 'vscode'
      ? { url: vscode, shortCircuit: true } : next(specifier, context),
  })
  try {
    const { readAssets } = await import('../src/assets.ts')
    const scene = { elements: ['img1', 'img2'].map(fileId => ({ type: 'image', fileId })) }
    const paths = new Map([['img1', 'assets/removed.svg'], ['img2', 'assets/kept.svg']])
    const errors = []
    const { files, missing } = await readAssets({ path: '/vault/file.md' }, scene, paths, error => errors.push(error))
    assert.deepEqual(missing, ['removed.svg'])
    assert.equal(files.img2.dataURL, 'data:image/svg+xml;base64,AQID')
    assert.equal(errors.length, 1)
    assert.match(errors[0].message, /\/vault\/assets\/removed\.svg$/)
  } finally {
    hooks.deregister()
  }
})
