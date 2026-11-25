import { CaptureUpdateAction, convertToExcalidrawElements, Excalidraw, viewportCoordsToSceneCoords } from '@excalidraw/excalidraw'
import type { AppState, BinaryFileData, ExcalidrawImperativeAPI, ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types'
import '@excalidraw/excalidraw/index.css'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { Element, Scene } from './format.ts'
import { imageImportLimit, importedImageTypes, type ImportedImage, type Message, type Request, type State } from './protocol.ts'
import { createSceneDiff, displayElements, isPortableText } from './scene.ts'
import { strings } from './strings.ts'
import { renderReferenceImages } from './reference-art.ts'
import { webLink } from './web.ts'
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
let importFlight = Promise.resolve()
let imageNotice: string | undefined
const pendingImages = new Map<string, ImportedImage>()
let incomingState = 0
let pdfCards: Awaited<ReturnType<typeof renderReferenceImages>>['files'] = {}
let permittedWebOrigins = new Set<string>()

const capture = () => structuredClone(api!.getSceneElementsIncludingDeleted()) as unknown as Element[]

function request(command: { kind: 'patch'; version: number; patch: ReturnType<typeof diff>; images?: ImportedImage[] }
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
      const fileIds = new Set(patch.elements.flatMap(({ fields }) => fields.fileId && !fields.isDeleted ? [fields.fileId] : []))
      const images = [...pendingImages.values()].filter(image => fileIds.has(image.id))
      const result = await request({ kind: 'patch', version: revision, patch, ...(images.length ? { images } : {}) })
      if (result.reason) {
        if (result.reason === 'disabled') return false
        if (result.reason !== 'inactive') issue = result.reason
        break
      }
      for (const image of images) pendingImages.delete(image.id)
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
  await importFlight
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
    elements: displayElements(scene.elements) as unknown as ExcalidrawInitialDataState['elements'],
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
  pendingImages.clear()
  imageNotice = undefined
  mount++
}

function importImages(files: File[], point: { clientX: number; clientY: number }) {
  if (!enabled || !editing || !api || issue || api.getAppState().editingTextElement) return
  if (files.some(file => !Object.hasOwn(importedImageTypes, file.type))
    || files.reduce((bytes, file) => bytes + file.size, 0) > imageImportLimit) {
    imageNotice = words.imageTypes
    render()
    return
  }
  const editor = api
  const { x, y } = viewportCoordsToSceneCoords(point, editor.getAppState())
  imageNotice = undefined
  // Handle only raster images here. The SDK's file-drop path can replace the
  // entire scene when a PNG carries Excalidraw export metadata.
  importFlight = importFlight.then(async () => {
    const bitmaps = await Promise.all(files.map(async (file, index) => {
      const dataURL = await new Promise<BinaryFileData['dataURL']>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as BinaryFileData['dataURL'])
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(file)
      })
      const image = new Image()
      image.src = dataURL
      await image.decode()
      const id = crypto.randomUUID().replaceAll('-', '') as BinaryFileData['id']
      const scale = Math.min(1, 480 / Math.max(image.naturalWidth, image.naturalHeight))
      const data: BinaryFileData = { id, dataURL, mimeType: file.type as keyof typeof importedImageTypes, created: Date.now() }
      return {
        data,
        shape: { type: 'image' as const, fileId: id, status: 'saved' as const,
          x: x + index * 24, y: y + index * 24, width: image.naturalWidth * scale, height: image.naturalHeight * scale },
      }
    }))
    if (!enabled || !editing || api !== editor || issue) return
    const added = convertToExcalidrawElements(bitmaps.map(bitmap => bitmap.shape))
    for (const { data } of bitmaps) pendingImages.set(data.id, data)
    editor.addFiles(bitmaps.map(bitmap => bitmap.data))
    editor.updateScene({
      elements: [...editor.getSceneElementsIncludingDeleted(), ...added],
      appState: { selectedElementIds: Object.fromEntries(added.map(element => [element.id, true])) },
      captureUpdate: CaptureUpdateAction.NEVER,
    })
    schedule()
  }).catch(error => {
    console.error(error)
    if (api === editor) {
      imageNotice = words.imageFailed
      render()
    }
  })
}

function bind(next: ExcalidrawImperativeAPI) {
  api = next
}

function applyState(data: State, cards: typeof pdfCards = {}) {
  if (!data.force && (flight || hasChanges())) {
    // Resuming the addon on the same document revision must not replace a draft.
    if (data.version !== revision) issue = 'conflict'
    else schedule()
  } else {
    pdfCards = cards
    const first = !doc?.scene
    doc = data
    issue = undefined
    revision = data.version
    if (data.scene) install(data.scene)
    if (first || data.force || !data.scene) editing = false
  }
}

window.addEventListener('message', ({ data, origin }: MessageEvent<Message>) => {
  // VS Code's outer webview relays on this origin. A sandboxed child has an opaque origin.
  if (origin !== window.origin || origin === 'null' || !data) return
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
    case 'web-policy':
      permittedWebOrigins = new Set(data.origins)
      break
    case 'state': {
      if (data.enabled && !data.force && data.version < revision) return
      const incoming = ++incomingState
      enabled = data.enabled
      dirty = data.dirty
      if (!enabled) break
      const { scene, references } = data
      const pdfs = Object.fromEntries(Object.entries(references?.cards ?? {}).filter(
        (entry): entry is [string, Extract<NonNullable<typeof entry[1]>, { kind: 'pdf' }>] => entry[1]?.kind === 'pdf'))
      if (scene && references && (Object.keys(references.images).length || Object.keys(pdfs).length)) {
        const rootUrl = new URL('./', import.meta.url).href
        void Promise.all([renderReferenceImages(references.images, rootUrl), renderReferenceImages(pdfs, rootUrl)])
          .then(([images, cards]) => {
            if (incoming !== incomingState || (!data.force && data.version < revision)) return
            applyState({ ...data, scene: { ...scene, files: { ...scene.files, ...images.files } },
              references: { cards: references.cards, images: {} }, missing: [...data.missing, ...images.missing] }, cards.files)
            render()
          })
        break
      }
      applyState(data)
      break
    }
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

function WebCard({ url, canPreview, interactive }: { url: URL; canPreview: boolean; interactive: boolean }) {
  const [opened, setOpened] = useState(false)
  return <section className="board-reference board-web-reference" data-web-origin={url.origin}>
    <header className="board-web-header">
      <strong>{url.host}</strong>
      <div className="board-web-actions" onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
        <button type="button" disabled={!interactive}
          onClick={() => bridge.postMessage({ kind: 'link', link: url.href })}>{words.openWebsite}</button>
        {canPreview && <button type="button" disabled={!interactive}
          onClick={() => setOpened(!opened)}>{opened ? words.hideWebPreview : words.loadWebPreview}</button>}
      </div>
    </header>
    {canPreview && opened
      ? <iframe title={url.host} src={url.href} sandbox="allow-scripts" referrerPolicy="no-referrer"
          style={{ pointerEvents: interactive ? 'auto' : 'none' }} />
      : <p>{url.pathname}{url.search}{url.hash}</p>}
  </section>
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
    {usable && !failed && imageNotice && <div className="board-notice" role="status">{imageNotice}</div>}
    {usable && !failed && doc!.missing.length > 0 && <div className="board-notice" role="status">
      {words.missing} {doc!.missing.join(', ')}
    </div>}
    <main className="board-canvas"
      onDragOverCapture={event => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault()
          event.dataTransfer.dropEffect = editing && enabled ? 'copy' : 'none'
        }
      }}
      onDropCapture={event => {
        const files = Array.from(event.dataTransfer.files)
        if (!files.length) return
        event.preventDefault()
        event.stopPropagation()
        importImages(files, { clientX: event.clientX, clientY: event.clientY })
      }}
      onPasteCapture={event => {
        const files = Array.from(event.clipboardData.files)
        if (!files.length || api?.getAppState().editingTextElement) return
        event.preventDefault()
        event.stopPropagation()
        const box = event.currentTarget.getBoundingClientRect()
        importImages(files, { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 })
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
        validateEmbeddable={link => !!webLink(link) || (doc?.scene?.elements.some(element => element.link === link
          && Object.hasOwn(doc?.references?.cards ?? {}, element.id)) ?? false)}
        renderEmbeddable={element => {
          const link = element.link ?? ''
          const url = webLink(link)
          if (url) {
            const canPreview = !!enabled && permittedWebOrigins.has(url.origin)
            return <WebCard key={url.href + ':' + canPreview} url={url} canPreview={canPreview} interactive={!!enabled && !editing} />
          }
          const reference = doc?.references?.cards[element.id]
          const label = link.slice(2, -2).split('|', 1)[0]
          return <section className="board-reference">
            <button type="button" aria-label={words.openSource + label} disabled={!enabled || editing}
              onPointerDown={event => event.stopPropagation()}
              onClick={event => {
                event.stopPropagation()
                bridge.postMessage({ kind: 'link', link })
              }}>{label}</button>
            {reference?.kind === 'note' ? <div className="board-reference-text" dangerouslySetInnerHTML={{ __html: reference.html }} />
              : pdfCards[element.id] ? <img src={pdfCards[element.id].dataURL} alt={label} />
                : <p>{words.referenceUnavailable}</p>}
          </section>
        }}
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
