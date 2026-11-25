import type { BinaryFileData } from '@excalidraw/excalidraw/types'
import type { LocalContent } from './references.ts'

export async function referenceArtwork(reference: LocalContent, assetRoot: string): Promise<BinaryFileData['dataURL']> {
  if (reference.kind === 'pdf') {
    const url = new URL('./pdf-render.js', assetRoot).href
    const { renderPdfPage }: typeof import('./pdf-render.ts') = await import(url)
    return await renderPdfPage(reference) as BinaryFileData['dataURL']
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

export async function renderReferenceImages(references: Record<string, LocalContent>, assetRoot: string) {
  const missing: string[] = []
  const files = Object.fromEntries((await Promise.all(Object.entries(references).map(async ([id, content]) => {
    try {
      const file: BinaryFileData = {
        id: id as BinaryFileData['id'], mimeType: 'image/png', dataURL: await referenceArtwork(content, assetRoot), created: 0,
      }
      return [[id, file]]
    } catch (error) {
      console.error('Could not render local drawing attachment:', error)
      missing.push(id)
      return []
    }
  }))).flat())
  return { files, missing }
}
