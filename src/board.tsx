import { Excalidraw } from '@excalidraw/excalidraw'
import type { AppState, ExcalidrawImperativeAPI, ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types'
import '@excalidraw/excalidraw/index.css'
import { createRoot } from 'react-dom/client'
import type { Element, Scene } from './format.ts'
import type { Message, Request, State } from './protocol.ts'
import { createSceneDiff, isPortableText } from './scene.ts'
import { strings } from './strings.ts'
import './board.css'

declare global {
  interface Window { boardLocale: string }
}
declare function acquireVsCodeApi(): { postMessage(message: Request): void }
const bridge = acquireVsCodeApi()
const locale = window.boardLocale
const words = strings(locale)
const root = createRoot(document.getElementById('root')!)
let api: ExcalidrawImperativeAPI | undefined
let doc: State | undefined
let enabled: boolean | undefined
let revision = 0
let mount = 0
let editing = false
let pressed = false
let baseline: Element[] | undefined
let diff = createSceneDiff([])
let dirty = false
let issue: Exclude<Extract<Message, { kind: 'result' }>['reason'], 'inactive' | 'disabled'>
let scheduled = false
let flight: Promise<boolean> | undefined
let nextId = 0
const waiting = new Map<number, (result: Extract<Message, { kind: 'result' }>) => void>()
let initial: ExcalidrawInitialDataState
let viewed = false

const capture = () => structuredClone(api!.getSceneElementsIncludingDeleted()) as unknown as Element[]

function request(command: { kind: 'patch'; version: number; patch: ReturnType<typeof diff> }
  | { kind: 'save' | 'markdown' | 'undo' | 'redo' }) {
  const id = ++nextId
  return new Promise<Extract<Message, { kind: 'result' }>>(resolve => {
    waiting.set(id, resolve)
    bridge.postMessage({ ...command, id })
  })
}

function hasChanges() {
  if (!editing || !api || !baseline) return false
  const patch = diff(baseline, capture())
  return !!(patch.elements.length || patch.order)
}

function flush(): Promise<boolean> {
  if (!enabled || (issue && issue !== 'reservedText')) return Promise.resolve(false)
  if (flight) return flight
  if (!editing || !api || !baseline) return Promise.resolve(true)
  const validateText = (patch: ReturnType<typeof diff>) => {
    const reserved = patch.elements.some(({ fields }) => !fields.isDeleted
      && typeof fields.originalText === 'string' && !isPortableText(fields.originalText))
    const previous = issue
    issue = reserved ? 'reservedText' : undefined
    if (previous !== issue) render()
    return !reserved
  }
  if (!validateText(diff(baseline, capture()))) return Promise.resolve(false)
  if (!hasChanges()) return Promise.resolve(true)
  flight = (async () => {
    while (enabled && baseline && editing && api && !issue && !pressed && !api.getAppState().editingTextElement) {
      const elements = capture()
      const patch = diff(baseline, elements)
      if (!patch.elements.length && !patch.order) break
      if (!validateText(patch)) break
      const result = await request({ kind: 'patch', version: revision, patch })
      if (result.reason) {
        if (result.reason === 'disabled') return false
        if (result.reason !== 'inactive') issue = result.reason
        break
      }
      baseline = elements
      revision = result.version
    }
    return !!enabled && !issue
  })().finally(() => {
    flight = undefined
    render()
  })
  render()
  return flight
}

function schedule(state?: AppState) {
  if (!enabled || scheduled || !editing || pressed || (issue && issue !== 'reservedText') || (state ?? api?.getAppState())?.editingTextElement) return
  scheduled = true
  queueMicrotask(() => {
    scheduled = false
    if (!pressed && !api?.getAppState().editingTextElement) void flush()
  })
}

async function finishOperation(kind: 'save' | 'markdown' | 'undo' | 'redo' | 'done') {
  if (kind === 'markdown' && (!enabled || issue)) {
    // Retain the canvas and its pending changes, and open the underlying file in the other tab.
    await request({ kind })
    return
  }
  if (api?.getAppState().editingTextElement) {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    await new Promise(resolve => requestAnimationFrame(resolve))
  }
  if (!await flush()) return
  if (kind === 'done') {
    editing = false
  } else {
    const result = await request({ kind })
    if (result.reason && result.reason !== 'inactive' && result.reason !== 'disabled') issue = result.reason
  }
  render()
}

function changeMode() {
  if (editing) {
    void finishOperation('done')
  } else {
    baseline = capture()
    editing = true
    render()
  }
}

function install(scene: Scene) {
  const old = api?.getAppState()
  const persisted = scene.appState ?? {}
  initial = {
    elements: scene.elements as unknown as ExcalidrawInitialDataState['elements'],
    files: scene.files as ExcalidrawInitialDataState['files'],
    appState: {
      ...(typeof persisted.viewBackgroundColor === 'string' ? { viewBackgroundColor: persisted.viewBackgroundColor } : {}),
      ...(old && viewed ? { scrollX: old.scrollX, scrollY: old.scrollY, zoom: old.zoom } : {}),
    },
    scrollToContent: !viewed,
  }
  viewed = true
  api = undefined
  baseline = undefined
  diff = createSceneDiff(scene.elements.map(element => element.id))
  mount++
}

function bind(next: ExcalidrawImperativeAPI) {
  api = next
}

window.addEventListener('message', ({ data }: MessageEvent<Message>) => {
  switch (data.kind) {
    case 'result': {
      const resolve = waiting.get(data.id)
      waiting.delete(data.id)
      resolve?.(data)
      return
    }
    case 'status':
      dirty = data.dirty
      break
    case 'state':
      if (data.enabled && !data.force && data.version < revision) return
      enabled = data.enabled
      dirty = data.dirty
      if (!enabled) break
      if (!data.force && (flight || hasChanges())) {
        // Resuming the addon on the same document revision must not replace a draft.
        if (data.version !== revision) issue = 'conflict'
        else schedule()
      } else {
        const first = !doc?.scene
        doc = data
        issue = undefined
        revision = data.version
        if (data.scene) install(data.scene)
        if (first || data.force || !data.scene) editing = false
      }
      break
  }
  render()
})

window.addEventListener('pointerup', () => {
  if (pressed) {
    pressed = false
    schedule()
  }
})
window.addEventListener('pointercancel', () => {
  pressed = false
  schedule()
})
window.addEventListener('keydown', event => {
  if (!enabled || !(event.ctrlKey || event.metaKey) || event.altKey || !doc?.scene) return
  const key = event.key.toLowerCase()
  const command = key === 's' ? 'save'
    : (editing && !api?.getAppState().editingTextElement && (key === 'z' || key === 'y'))
      ? (key === 'y' || event.shiftKey ? 'redo' : 'undo')
      : null
  if (!command) return
  event.preventDefault()
  event.stopImmediatePropagation()
  void finishOperation(command)
}, true)

const onChange = (_elements: readonly unknown[], state: AppState) => {
  if (state.isLoading || !api) return
  if (!baseline) {
    baseline = capture()
    render()
    return
  }
  schedule(state)
}

function render() {
  const usable = !!doc?.scene && enabled
  const failed = enabled === false ? words.disabled : issue ? words[issue] : doc && !doc.scene ? words.badFile : undefined
  const pending = dirty || !!issue
  const status = editing ? (flight ? words.working : pending ? words.unsaved : words.saved)
    : pending ? words.read + ' · ' + words.unsaved : words.read
  const dark = /(?:vscode-dark|vscode-high-contrast)(?: |$)/.test(document.body.className)
  root.render(<>
    <header className="board-toolbar" aria-label="Excalidraw">
      <div className="board-mode">
        {usable && <button className="primary" onClick={changeMode} disabled={!baseline || !!issue}>
          {editing ? words.done : words.edit}
        </button>}
        {usable && <span className="board-status" aria-live="polite">{status}</span>}
      </div>
      <div className="board-actions">
        {editing && usable && <>
          <button disabled={!!issue} onClick={() => void finishOperation('undo')}>{words.undo}</button>
          <button disabled={!!issue} onClick={() => void finishOperation('redo')}>{words.redo}</button>
          <button disabled={!!issue || (!dirty && !flight)} onClick={() => void finishOperation('save')}>{words.save}</button>
        </>}
        <button onClick={() => void finishOperation('markdown')}>{words.markdown}</button>
      </div>
    </header>
    {failed && <div className="board-notice" role="status">
      <span>{failed}</span>
      {enabled && issue && <button onClick={() => bridge.postMessage({ kind: 'reload' })}>{words.reload}</button>}
    </div>}
    {usable && !failed && doc!.missing.length > 0 && <div className="board-notice" role="status">
      {words.missing} {doc!.missing.join(', ')}
    </div>}
    <main className="board-canvas" onDropCapture={event => {
      if (event.dataTransfer.files.length) {
        event.preventDefault()
        event.stopPropagation()
      }
    }}>
      {!doc && enabled !== false && <p role="status">{words.loading}</p>}
      {doc?.scene && <Excalidraw key={mount} initialData={initial} excalidrawAPI={bind}
        langCode={locale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'}
        viewModeEnabled={!enabled || !editing || (!!issue && issue !== 'reservedText')} theme={dark ? 'dark' : 'light'}
        onChange={onChange} onPointerDown={() => { pressed = true }}
        onLinkOpen={(element, event) => {
          event.preventDefault()
          if (element.link) bridge.postMessage({ kind: 'link', link: element.link })
        }}
        onPaste={(data, event) => !event?.clipboardData?.files.length
          && !data.elements?.some(element => element.type === 'image')}
        validateEmbeddable={false}
        UIOptions={{ tools: { image: false }, canvasActions: {
          changeViewBackgroundColor: false, clearCanvas: false, loadScene: false, saveToActiveFile: false,
          export: false, saveAsImage: false, toggleTheme: false,
        } }}
      />}
    </main>
  </>)
}
new MutationObserver(render).observe(document.body, { attributes: true, attributeFilter: ['class'] })
render()
bridge.postMessage({ kind: 'ready' })
