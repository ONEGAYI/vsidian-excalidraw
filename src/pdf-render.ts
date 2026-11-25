import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { LocalContent } from './references.ts'

let worker: Promise<string> | undefined

export async function renderPdfPage(content: Extract<LocalContent, { kind: 'pdf' }>) {
  GlobalWorkerOptions.workerSrc = await (worker ??= (async () => {
    const response = await fetch(new URL('./pdf-worker.js', import.meta.url))
    if (!response.ok) throw new Error('Could not load the local PDF renderer')
    return URL.createObjectURL(new Blob([await response.text()], { type: 'text/javascript' }))
  })())
  const data = Uint8Array.from(atob(content.bytes), c => c.charCodeAt(0))
  const task = getDocument({
    data, stopAtErrors: true,
    cMapUrl: new URL('./pdf-assets/cmaps/', import.meta.url).href,
    standardFontDataUrl: new URL('./pdf-assets/standard_fonts/', import.meta.url).href,
    wasmUrl: new URL('./pdf-assets/wasm/', import.meta.url).href,
    iccUrl: new URL('./pdf-assets/iccs/', import.meta.url).href,
  })
  try {
    const pdf = await task.promise
    const page = await pdf.getPage(content.page)
    const atSize = page.getViewport({ scale: 1 })
    const viewport = page.getViewport({ scale: Math.min(3, 1050 / Math.max(atSize.width, atSize.height)) })
    const canvas = document.createElement('canvas')
    let left = 0, top = 0, right = viewport.width, bottom = viewport.height
    if (content.rect) {
      const [x1, y1] = viewport.convertToViewportPoint(content.rect[0], content.rect[1])
      const [x2, y2] = viewport.convertToViewportPoint(content.rect[2], content.rect[3])
      left = Math.max(0, Math.min(x1, x2))
      top = Math.max(0, Math.min(y1, y2))
      right = Math.min(viewport.width, Math.max(x1, x2))
      bottom = Math.min(viewport.height, Math.max(y1, y2))
      if (right <= left || bottom <= top) throw new Error('PDF crop is outside the selected page')
    }
    canvas.width = Math.ceil(right - left)
    canvas.height = Math.ceil(bottom - top)
    await page.render({ canvas, viewport, transform: [1, 0, 0, 1, -left, -top] }).promise
    return canvas.toDataURL('image/png')
  } finally {
    await task.destroy()
  }
}
