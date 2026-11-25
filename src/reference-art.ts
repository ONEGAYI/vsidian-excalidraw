import type { BinaryFileData } from '@excalidraw/excalidraw/types'
import type { LocalContent } from './references.ts'

let pdfQueue: Promise<void> = Promise.resolve()

async function referenceArtwork(reference: LocalContent, pdfs: Record<string, string>, assetRoot: string, signal?: AbortSignal): Promise<BinaryFileData['dataURL']> {
  if (reference.kind === 'pdf') {
    const url = new URL('./pdf-render.js', assetRoot).href
    const page = pdfQueue.then(async () => {
      signal?.throwIfAborted()
      const { renderPdfPage }: typeof import('./pdf-render.ts') = await import(url)
      signal?.throwIfAborted()
      return await renderPdfPage(reference, pdfs[reference.file]) as BinaryFileData['dataURL']
    })
    // Continue the queue after either outcome; the original rejection still reaches the caller.
    pdfQueue = page.then(() => {}, () => {})
    return page
  }
  const canvas = document.createElement('canvas')
  canvas.width = 640
  const context = canvas.getContext('2d')!
  const font = '20px sans-serif'
  context.font = font
  const doc = new DOMParser().parseFromString(reference.html, 'text/html')
  const paragraphs = Array.from(doc.body.children, el => el.textContent ?? '').join('\n').trim().split('\n')
  const lines: string[] = []
  for (const paragraph of paragraphs) {
    let line = ''
    for (const word of paragraph.split(/(?<=\s)/)) {
      if (line && context.measureText(line + word).width > 590) {
        lines.push(line.trimEnd())
        line = ''
      }
      line += word
    }
    lines.push(line.trimEnd())
    if (lines.length >= 35) break
  }
  canvas.height = 46 + Math.min(lines.length, 35) * 27
  context.fillStyle = 'white'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = '#222'
  context.font = font
  for (const [i, line] of lines.slice(0, 35).entries()) context.fillText(line, 24, 38 + i * 27, 590)
  return canvas.toDataURL('image/png') as BinaryFileData['dataURL']
}

export async function renderReferenceImages(references: Record<string, LocalContent>, pdfs: Record<string, string>, assetRoot: string, signal?: AbortSignal) {
  const missing: string[] = []
  const files: Record<string, BinaryFileData> = Object.create(null)
  for (const [id, content] of Object.entries(references)) {
    if (signal?.aborted) break
    try {
      files[id] = {
        id: id as BinaryFileData['id'], mimeType: 'image/png', dataURL: await referenceArtwork(content, pdfs, assetRoot, signal), created: 0,
      }
    } catch (error) {
      if (signal?.aborted) break
      console.error('Could not render local drawing attachment:', error)
      missing.push(id)
    }
  }
  return { files, missing }
}
