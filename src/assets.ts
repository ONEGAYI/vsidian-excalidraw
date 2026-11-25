import { basename, extname, posix } from 'node:path'
import { FileSystemError, RelativePattern, Uri, workspace } from 'vscode'
import type { Scene } from './format.ts'

const mimeTypes = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
} as const

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
