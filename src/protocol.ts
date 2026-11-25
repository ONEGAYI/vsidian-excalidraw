import type { DrawingPatch, Scene } from './format.ts'

export type Request =
  | { kind: 'ready' | 'reload' }
  | { kind: 'patch'; id: number; version: number; patch: DrawingPatch }
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
