import { basename, extname, posix } from 'node:path'
import { FileSystemError, RelativePattern, Uri, workspace } from 'vscode'
import type { DrawingPatch, Scene } from './format.ts'
import { imageImportLimit, importedImageTypes, type ImportedImage } from './protocol.ts'

const mimeTypes = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
} as const

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
  const imageIds = [...new Set(scene.elements.flatMap(e => !e.isDeleted && e.type === 'image' && e.fileId ? [e.fileId] : []))]
  await Promise.all(imageIds.map(async id => {
    if (files[id]) return
    const target = attachments.get(id)?.split(/[|#]/, 1)[0]
    if (target) {
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
  }))
  return { files, missing }
}
