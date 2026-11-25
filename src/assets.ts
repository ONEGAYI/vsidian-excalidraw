import { basename, extname, posix } from 'node:path'
import { FileSystemError, RelativePattern, Uri, workspace } from 'vscode'
import type { DrawingPatch, Scene } from './format.ts'
import { imageImportLimit, importedImageTypes, type ImportedImage, type LocalReferences } from './protocol.ts'
import { localReference, notePreview, type LocalContent } from './references.ts'

const mimeTypes = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
} as const
const pdfFileLimit = 32 * 1024 * 1024
const drawingPdfLimit = 2 * pdfFileLimit

export function stageImportedImages(source: Uri, images: ImportedImage[], patch: DrawingPatch) {
  if (!Array.isArray(images)) throw new Error('invalid-image-import')
  const fileIds = new Set(patch.elements.flatMap(({ fields }) =>
    fields.type === 'image' && !fields.isDeleted && fields.fileId ? [fields.fileId] : []))
  let total = 0
  return images.map(({ id, dataURL }) => {
    if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id) || !fileIds.delete(id)
      || typeof dataURL !== 'string' || dataURL.length > Math.ceil(imageImportLimit / 3) * 4 + 32) {
      throw new Error('invalid-image-import')
    }
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+=*)$/.exec(dataURL)
    if (!match) throw new Error('invalid-image-import')
    const mime = match[1] as keyof typeof importedImageTypes
    const bytes = Buffer.from(match[2], 'base64')
    total += bytes.length
    if (!bytes.length || total > imageImportLimit) throw new Error('invalid-image-import')
    const target = `excalidraw-${id}.${importedImageTypes[mime]}`
    return { id, target, bytes, uri: Uri.joinPath(source, '..', target) }
  })
}

export async function localResource(source: Uri, target: string): Promise<Uri | undefined> {
  if (!target || target.startsWith('/') || /[:\\\0*?[\]{}]/.test(target)) return
  const folder = workspace.getWorkspaceFolder(source)
  const parent = Uri.joinPath(source, '..')
  const candidates = [Uri.joinPath(parent, target)]
  if (folder) candidates.push(Uri.joinPath(folder.uri, target))
  for (const candidate of candidates) {
    const relative = posix.relative(folder?.uri.path ?? parent.path, candidate.path)
    if (relative === '..' || relative.startsWith('../')) continue
    try {
      await workspace.fs.stat(candidate)
      return candidate
    } catch (error) {
      if (!(error instanceof FileSystemError) || error.code !== 'FileNotFound') throw error
    }
  }
  if (folder && !target.includes('/')) {
    const matches = await workspace.findFiles(new RelativePattern(folder, '**/' + target), undefined, 2)
    if (matches.length === 1) return matches[0]
  }
}

export async function readAssets(uri: Uri, scene: Scene, attachments: Map<string, string>, report: (error: unknown) => void) {
  const files = { ...scene.files }
  const missing: string[] = []
  const references: LocalReferences = {
    cards: Object.create(null), images: Object.create(null), imageLinks: Object.create(null), pdfs: Object.create(null),
  }
  const cached = new Map<string, Promise<LocalContent | null>>()
  const pdfLoads = new Map<string, Promise<boolean>>()
  let pdfBytes = 0
  function load(target: NonNullable<ReturnType<typeof localReference>>) {
    const key = target.path + '#' + target.fragment
    const existing = cached.get(key)
    if (existing) return existing
    const result = (async () => {
      try {
        const file = await localResource(uri, target.path)
        if (!file) return null
        if (target.kind === 'pdf') {
          let pending = pdfLoads.get(file.path)
          if (!pending) {
            pending = (async () => {
              const { size } = await workspace.fs.stat(file)
              if (size > pdfFileLimit || pdfBytes + size > drawingPdfLimit) return false
              pdfBytes += size
              let retained = 0
              try {
                const bytes = await workspace.fs.readFile(file)
                if (bytes.byteLength > pdfFileLimit || pdfBytes - size + bytes.byteLength > drawingPdfLimit) return false
                references.pdfs[file.path] = Buffer.from(bytes).toString('base64')
                retained = bytes.byteLength
                return true
              } finally {
                pdfBytes += retained - size
              }
            })()
            pdfLoads.set(file.path, pending)
          }
          if (!await pending) return null
          return { kind: 'pdf' as const, file: file.path, page: target.page, rect: target.rect }
        }
        if ((await workspace.fs.stat(file)).size > 1024 * 1024) return null
        const document = await workspace.openTextDocument(file).then(opened => opened, error => {
          report(error)
          return null
        })
        if (!document) return null
        const preview = notePreview(document.getText(), target.fragment)
        return preview ? { kind: 'note' as const, ...preview } : null
      } catch (error) {
        if (!(error instanceof FileSystemError)) throw error
        report(error)
        return null
      }
    })()
    cached.set(key, result)
    return result
  }
  const cards = scene.elements.flatMap(element => {
    if (element.isDeleted || element.type !== 'embeddable' || !element.link) return []
    const target = localReference(element.link, true)
    return target ? [load(target).then(content => { references.cards[element.id] = content })] : []
  })
  const imageIds = [...new Set(scene.elements.flatMap(e => !e.isDeleted && e.type === 'image' && e.fileId ? [e.fileId] : []))]
  await Promise.all([...cards, ...imageIds.map(async id => {
    if (Object.hasOwn(files, id)) return
    const value = attachments.get(id)
    const target = value?.split(/[|#]/, 1)[0]
    if (target) {
      const reference = localReference(value!)
      if (reference) {
        const content = await load(reference)
        if (content) {
          references.images[id] = content
          references.imageLinks[id] = `[[${reference.path}${reference.fragment ? '#' + reference.fragment : ''}]]`
          return
        }
      }
      const mimeType = mimeTypes[extname(target).toLowerCase() as keyof typeof mimeTypes]
      if (mimeType) {
        try {
          const file = await localResource(uri, target)
          if (file) {
            const bytes = await workspace.fs.readFile(file)
            files[id] = { id, mimeType, created: 0, dataURL: 'data:' + mimeType + ';base64,' + Buffer.from(bytes).toString('base64') }
            return
          }
        } catch (error) {
          if (!(error instanceof FileSystemError)) throw error
          report(error)
        }
      }
    }
    missing.push(target ? basename(target) : id)
  })])
  return { files, missing, references }
}
