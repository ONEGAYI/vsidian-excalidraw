import { exportToCanvas } from '@excalidraw/excalidraw'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { BinaryFiles } from '@excalidraw/excalidraw/types'
import type { Scene } from './format.ts'

export async function renderThumbnail(scene: Scene) {
  const elements = scene.elements.filter(element => !element.isDeleted)
  if (elements.length === 0) return null
  const canvas = await exportToCanvas({
    elements: elements as unknown as ExcalidrawElement[],
    appState: {
      exportBackground: true,
      exportWithDarkMode: false,
      viewBackgroundColor: typeof scene.appState?.viewBackgroundColor === 'string' ? scene.appState.viewBackgroundColor : '#fff',
    },
    files: scene.files as BinaryFiles,
    maxWidthOrHeight: 1000,
  })
  return canvas.toDataURL('image/png')
}
