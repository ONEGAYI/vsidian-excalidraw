import type { DrawingPatch, Scene } from './format.ts'

export const importedImageTypes = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
} as const
export const imageImportLimit = 8 * 1024 * 1024
export type ImportedImage = { id: string; dataURL: string }

export type Request =
  | { kind: 'ready' | 'reload' }
  | { kind: 'patch'; id: number; version: number; patch: DrawingPatch; images?: ImportedImage[] }
  | { kind: 'save' | 'markdown' | 'undo' | 'redo'; id: number }
  | { kind: 'link'; link: string }

export type State = {
  kind: 'state'
  version: number
  dirty: boolean
  enabled: boolean
  scene?: Scene
  missing: string[]
  force: boolean
}
export type Message = State
  | { kind: 'status'; dirty: boolean }
  | { kind: 'result'; id: number; version: number; reason?: 'conflict' | 'deleted' | 'disabled' | 'reservedText' | 'inactive' }
