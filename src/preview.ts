import { isDrawing, type Scene } from './format.ts'
import { strings } from './strings.ts'

type Target = { fsPath: string; relPath: string; text: string }
type PageSdk = {
  locale?: { get(): string }
  refViews?: {
    registerMarkdownPreview?: (provider: {
      matches(target: Target): boolean
      mount(container: HTMLElement, target: Target, signal: AbortSignal): Promise<void>
      open(target: Target): Promise<void>
    }) => { dispose(): void }
  }
  resourceUri(path: string): string | null
  channel: { request(topic: string, payload: unknown): Promise<{ ok: true; result: unknown } | { ok: false; reason: string }> }
}

function mountPage(sdk: PageSdk) {
  const register = sdk.refViews?.registerMarkdownPreview
  if (!register) return // The preview capability is not required for the standalone board.
  const artworkUrl = sdk.resourceUri('preview-art.js')
  if (!artworkUrl) throw new Error('Excalidraw preview resources were not registered')
  let artwork: Promise<typeof import('./preview-art.ts')> | undefined
  const open = async ({ fsPath }: Target) => {
    const outcome = await sdk.channel.request('drawing.open', { fsPath })
    if (!outcome.ok && outcome.reason !== 'released') throw new Error('Could not open the Excalidraw drawing: ' + outcome.reason)
  }
  register({
    matches: target => isDrawing(target.text),
    async mount(container, target, signal) {
      const words = strings(sdk.locale?.get() || document.documentElement.lang)
      container.textContent = words.loading
      ;(globalThis as typeof globalThis & { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = new URL('./', artworkUrl).href
      const [result, { renderThumbnail }] = await Promise.all([
        sdk.channel.request('drawing.preview', { fsPath: target.fsPath, text: target.text }),
        artwork ??= import(artworkUrl),
      ])
      if (signal.aborted) return
      let image: string | null
      let unavailable = !result.ok || !result.result
      try {
        image = result.ok && result.result ? await renderThumbnail(result.result as Scene) : null
      } catch (error) {
        console.error('Could not render Excalidraw preview:', error)
        image = null
        unavailable = true
      }
      if (signal.aborted) return
      const button = document.createElement('button')
      button.type = 'button'
      button.setAttribute('aria-label', words.openPreview + target.relPath)
      button.style.cssText = 'display:inline-block;max-width:100%;border:0;padding:0;background:none;color:inherit;cursor:pointer;'
      button.addEventListener('click', event => {
        event.stopPropagation()
        void open(target).catch(error => {
          console.error(error)
          if (!signal.aborted) container.textContent = words.previewUnavailable
        })
      }, { signal })
      if (image) {
        const thumbnail = document.createElement('img')
        thumbnail.dataset.excalidrawPreview = ''
        thumbnail.alt = target.relPath
        thumbnail.src = image
        thumbnail.style.cssText = 'display:block;max-width:100%;height:auto;'
        button.appendChild(thumbnail)
      } else {
        button.textContent = (unavailable ? words.previewUnavailable : words.emptyPreview) + ' ' + words.openPreview + target.relPath
      }
      container.replaceChildren(button)
    },
    open,
  })
}

// Vsidian's defineAddonPage bridge, as documented for IIFE editor entries.
const shell = globalThis as typeof globalThis & {
  __vsidianAddonPages?: Array<{ addonId: string; factory: (sdk: PageSdk) => void; registeredAt: number }>
}
;(shell.__vsidianAddonPages ??= []).push({
  addonId: 'ONEGAYI.vsidian-excalidraw', factory: mountPage, registeredAt: Date.now(),
})
