import { exportToCanvas } from '@excalidraw/excalidraw'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { BinaryFiles } from '@excalidraw/excalidraw/types'
import type { Scene } from './format.ts'
import type { LocalContent } from './references.ts'
import { renderReferenceImages } from './reference-art.ts'

export async function renderThumbnail(scene: Scene, references: Record<string, LocalContent>, assetRoot: string) {
  const elements = scene.elements.filter(element => !element.isDeleted)
  if (elements.length === 0) return null
  const { files } = await renderReferenceImages(references, assetRoot)
  const canvas = await exportToCanvas({
    elements: elements as unknown as ExcalidrawElement[],
    appState: {
      exportBackground: true,
      exportWithDarkMode: false,
      viewBackgroundColor: typeof scene.appState?.viewBackgroundColor === 'string' ? scene.appState.viewBackgroundColor : '#fff',
    },
    files: { ...scene.files, ...files } as BinaryFiles,
    maxWidthOrHeight: 1000,
  })
  return canvas.toDataURL('image/png')
}
