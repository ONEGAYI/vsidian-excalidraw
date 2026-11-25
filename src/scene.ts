import type { DrawingPatch, Element } from './format.ts'

const equal = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b)

export const isPortableElementId = (id: string): boolean => /^[A-Za-z0-9-]{8}$/.test(id)

// Excalidraw renders generated iframe HTML independently of validateEmbeddable.
// Project only what the renderer sees; diffs still preserve the source type and custom data.
export function displayElements(elements: readonly Element[], sourceLinks: Readonly<Record<string, string>> = {}): Element[] {
  return elements.map(element => {
    if (element.type === 'iframe') return { ...element, type: 'rectangle' }
    if (element.type === 'image' && !element.link && element.fileId && Object.hasOwn(sourceLinks, element.fileId)) {
      return { ...element, link: sourceLinks[element.fileId] }
    }
    return element
  })
}

export function isPortableText(text: string): boolean {
  return !/^#{1,2}[ \t]+(?:Excalidraw Data|Text Elements|Element Links|Embedded [Ff]iles|Drawing)[ \t]*\r?$/m.test(text)
    && !/^%%[ \t]*\r?$/m.test(text)
    && !/(?:^|[ \t])\^[\w!-]{8}[ \t]*\r?$/m.test(text)
}

export function canPasteSceneElements(elements?: readonly { type: string }[]): boolean {
  return !elements?.some(element => element.type === 'image' || element.type === 'iframe')
}

export function createSceneDiff(storedIds: Iterable<string>) {
  const ids = new Map(Array.from(storedIds, id => [id, id]))
  const reserved = new Set(ids.keys())
  function storedId(id: string): string {
    const existing = ids.get(id)
    if (existing) return existing
    let chosen = id.slice(0, 8)
    while (!isPortableElementId(chosen) || reserved.has(chosen)) chosen = crypto.randomUUID().slice(0, 8)
    reserved.add(chosen)
    ids.set(id, chosen)
    return chosen
  }

  return (before: readonly Element[], after: readonly Element[]): DrawingPatch => {
    const previous = new Map(before.map(element => [element.id, element]))
    const elements: DrawingPatch['elements'] = []
    for (const next of after) {
      const old = previous.get(next.id)
      const entries = Object.entries(next).filter(([key, value]) => key !== 'id' && !equal(old?.[key], value))
      if (!entries.length) continue
      for (const entry of entries) {
        const [key, value] = entry
        if ((key === 'containerId' || key === 'frameId') && typeof value === 'string') entry[1] = storedId(value)
        if ((key === 'startBinding' || key === 'endBinding') && value) {
          const binding = value as { elementId: string }
          entry[1] = { ...binding, elementId: storedId(binding.elementId) }
        }
        if (key === 'boundElements' && Array.isArray(value)) {
          entry[1] = value.map((bound: { id: string }) => ({ ...bound, id: storedId(bound.id) }))
        }
      }
      elements.push({ id: storedId(next.id), fields: Object.fromEntries(entries) })
    }
    const orderChanged = before.length !== after.length || after.some((element, i) => element.id !== before[i].id)
    return { elements, ...(orderChanged ? { order: after.map(element => storedId(element.id)) } : {}) }
  }
}
