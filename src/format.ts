import lz from 'lz-string'
import { parseDocument } from 'yaml'
import { isPortableElementId, isPortableText } from './scene.ts'

export type Element = {
  id: string
  type: string
  isDeleted?: boolean
  text?: string
  originalText?: string
  rawText?: string
  link?: string | null
  fileId?: string | null
  [field: string]: unknown
}
export type Scene = {
  type: 'excalidraw'
  version: number
  elements: Element[]
  appState?: Record<string, unknown>
  files?: Record<string, unknown>
  [field: string]: unknown
}

type Span = { from: number; to: number }
type RecordSpan = Span & { value: string; contentEnd: number }
type Section = Span & { records: Map<string, RecordSpan> }
type DataSections = Partial<Record<'Text Elements' | 'Element Links' | 'Embedded Files', Section>>

const FRONTMATTER = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/
const DRAWING = /^#{1,2} Drawing[ \t]*\r?\n```(json|compressed-json)[ \t]*\r?\n([\s\S]*?)^```[ \t]*\r?$/dmy

function unfencedHeadings(source: string, start: number) {
  const headings = new Map<number, string>()
  const lines = /^[^\r\n]+/gm
  lines.lastIndex = start
  let fence = ''
  let textSection = false
  for (const { 0: line, index } of source.matchAll(lines)) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    // Excalidraw labels are raw text records; their block ID ends even a literal fence.
    const recordEnd = textSection && /(?:[ \t]|^)\^[\w!-]{8}[ \t]*$/.test(line)
    if (fence) {
      if (recordEnd || (delimiter && delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length && /^[ \t]*$/.test(delimiter[2]))) {
        fence = ''
      }
    } else if (delimiter) {
      if (!recordEnd && (delimiter[1][0] === '~' || !delimiter[2].includes('`'))) fence = delimiter[1]
    } else {
      const heading = /^(?:# (Excalidraw Data)|#{1,2} (Drawing|Text Elements|Element Links|Embedded [Ff]iles))[ \t]*$/.exec(line)
      if (heading) {
        const name = heading[1] ?? heading[2]
        headings.set(index, name)
        textSection = name === 'Text Elements'
      }
    }
  }
  return headings
}

export function isDrawing(source: string): boolean {
  const yaml = FRONTMATTER.exec(source)?.[1]
  if (!yaml?.includes('excalidraw-plugin')) return false
  const metadata = parseDocument(yaml)
  return metadata.errors.length === 0 && Boolean(metadata.get('excalidraw-plugin'))
}

function textRecords(source: string, { from, to }: Span): Map<string, RecordSpan> {
  const records = new Map<string, RecordSpan>()
  const body = source.slice(from, to)
  let cursor = 0
  // Obsidian puts one separator before ^ and consumes the line breaks after the ID.
  for (const record of body.matchAll(/(?:[ \t]|^)\^([\w!-]{8})[ \t]*(?:(?:\r?\n)+|$)/gm)) {
    const value = body.slice(cursor, record.index).replace(/\r\n/g, '\n')
    records.set(record[1], { from: from + cursor, contentEnd: from + record.index, to: from + record.index + record[0].length, value })
    cursor = record.index + record[0].length
  }
  return records
}

function keyedRecords(source: string, { from, to }: Span): Map<string, RecordSpan> {
  const records = new Map<string, RecordSpan>()
  for (const record of source.slice(from, to).matchAll(/^([\w-]+):[ \t]*([^\r\n]*)(?:\r?\n|$)/gm)) {
    const start = from + record.index
    records.set(record[1], {
      from: start,
      to: start + record[0].length,
      contentEnd: start + record[0].trimEnd().length,
      value: record[2].trim(),
    })
  }
  return records
}

function readSections(source: string, start: number, end: number, elements: Element[], unfenced: Map<number, string>): DataSections {
  const body = source.slice(start, end)
  const headings = [...body.matchAll(/^#{1,2} (Text Elements|Element Links|Embedded [Ff]iles)[ \t]*\r?\n/gm)]
    .filter(heading => unfenced.has(start + heading.index))
  const sections: DataSections = {}
  for (const [index, heading] of headings.entries()) {
    const key = heading[1] === 'Embedded files' ? 'Embedded Files' : heading[1] as keyof DataSections
    if (sections[key]) throw new Error('ambiguous-drawing-sections')
    const from = start + heading.index + heading[0].length
    const next = headings[index + 1]
    let to = next ? start + next.index : end
    const comment = /(?:^|\n)%%[ \t]*\r?\n(?:[ \t]*\r?\n)*$/.exec(source.slice(from, to))
    if (comment) to = from + comment.index + (comment[0][0] === '\n' ? 1 : 0)
    const span = { from, to }
    if (key === 'Text Elements' && next) {
      const all = textRecords(source, { from, to: end })
      if (elements.some(element => element?.type === 'text' && (all.get(element.id)?.to ?? 0) > to)) {
        throw new Error('ambiguous-drawing-sections')
      }
    }
    sections[key] = { ...span, records: key === 'Text Elements' ? textRecords(source, span) : keyedRecords(source, span) }
  }
  return sections
}

export function readDrawing(source: string) {
  if (!isDrawing(source)) throw new Error('not-drawing')
  const bodyStart = FRONTMATTER.exec(source)![0].length
  const headings = unfencedHeadings(source, bodyStart)
  const drawing = new RegExp(DRAWING)
  const blocks = []
  for (const [index, heading] of headings) {
    if (heading !== 'Drawing') continue
    drawing.lastIndex = index
    const block = drawing.exec(source)
    if (block) blocks.push(block)
  }
  if (blocks.length !== 1) throw new Error('drawing-section')
  const block = blocks[0]
  const kind = block[1] as 'json' | 'compressed-json'
  const json = kind === 'json' ? block[2] : lz.decompressFromBase64(block[2].replace(/\s/g, ''))
  const stored = JSON.parse(json || 'null') as Scene | null
  if (!stored || stored.type !== 'excalidraw' || typeof stored.version !== 'number' || !Array.isArray(stored.elements)) {
    throw new Error('invalid-scene')
  }
  const header = [...headings].filter(([index, heading]) => index < block.index && heading === 'Excalidraw Data').at(-1)?.[0]
  const sections = readSections(source, header ?? bodyStart, block.index, stored.elements, headings)
  const elements = stored.elements.map(element => {
    if (!element || typeof element.id !== 'string' || typeof element.type !== 'string') throw new Error('invalid-element')
    const text = sections['Text Elements']?.records.get(element.id)?.value
    const link = sections['Element Links']?.records.get(element.id)?.value
    const rawText = element.type === 'text' ? text ?? (typeof element.rawText === 'string' ? element.rawText : undefined) : undefined
    if (rawText === undefined && link === undefined) return element
    return {
      ...element,
      // The SDK paints `text` but uses `originalText` as its editing input.
      ...(rawText === undefined ? {} : { rawText, originalText: rawText }),
      ...(rawText !== undefined && text !== undefined && text !== element.rawText ? { text } : {}),
      ...(link === undefined ? {} : { link }),
    }
  })
  const attachments = new Map<string, string>()
  for (const [id, record] of sections['Embedded Files']?.records ?? []) {
    const wikilink = /^!?\[\[([^\]\r\n]+)\]\]/.exec(record.value)
    if (wikilink) attachments.set(id, wikilink[1])
  }
  const [from, to] = block.indices![2]!
  return {
    scene: { ...stored, elements },
    stored,
    sections,
    attachments,
    payload: { from, to, kind },
    drawingStart: block.index,
    eol: source.includes('\r\n') ? '\r\n' : '\n',
  }
}

export type DrawingPatch = {
  elements: { id: string; fields: Partial<Element> }[]
  order?: string[]
  attachments?: { id: string; target: string }[]
}
export type DrawingEdit = Span & { text: string }

export function writeDrawing(source: string, patch: DrawingPatch): DrawingEdit[] {
  if (!patch.elements.length && !patch.order && !patch.attachments?.length) return []
  const { stored, sections, payload, eol, drawingStart } = readDrawing(source)
  const elements = new Map(stored.elements.map(element => [element.id, element]))
  const edits: DrawingEdit[] = []
  let appendText = ''
  let appendLinks = ''
  const textSection = sections['Text Elements']
  const linkSection = sections['Element Links']
  const attachmentSection = sections['Embedded Files']

  for (const { id, fields } of patch.elements) {
    if (!elements.has(id) && (!isPortableElementId(id) || !fields.type)) {
      throw new Error('invalid-new-element')
    }
    const element = { ...elements.get(id), ...fields, id } as Element
    const textRecord = textSection?.records.get(id)
    const linkRecord = linkSection?.records.get(id)
    if (element.isDeleted) {
      if (textRecord) edits.push({ from: textRecord.from, to: textRecord.to, text: '' })
      if (linkRecord) edits.push({ from: linkRecord.from, to: linkRecord.to, text: '' })
    } else {
      if (element.type === 'text' && (Object.hasOwn(fields, 'originalText') || !elements.has(id) || (!textRecord && fields.isDeleted === false))) {
        const text = element.originalText ?? element.text ?? ''
        if (!isPortableText(text)) throw new Error('reserved-text')
        element.rawText = text
        const normalized = text.replace(/\r?\n/g, eol)
        if (textRecord) {
          edits.push({ from: textRecord.from, to: textRecord.contentEnd, text: normalized })
        } else {
          appendText += `${normalized} ^${id}${eol}${eol}`
        }
      }
      if (Object.hasOwn(fields, 'link') || (!linkRecord && fields.isDeleted === false)) {
        if (!element.link) {
          if (linkRecord) edits.push({ from: linkRecord.from, to: linkRecord.to, text: '' })
        } else if (linkRecord) {
          edits.push({ from: linkRecord.from, to: linkRecord.contentEnd, text: `${id}: ${element.link}` })
        } else {
          appendLinks += `${id}: ${element.link}${eol}${eol}`
        }
      }
    }
    elements.set(id, element)
  }

  const comment = /(?:^|\n)%%[ \t]*\r?\n(?:[ \t]*\r?\n)*$/.exec(source.slice(0, drawingStart))
  const dataEnd = comment ? comment.index + (comment[0][0] === '\n' ? 1 : 0) : drawingStart
  const sectionStart = (section: Section) => source.lastIndexOf('\n', section.from - 2) + 1
  const beforeAttachments = attachmentSection ? sectionStart(attachmentSection) : dataEnd
  const insertions = new Map<number, string>()
  if (appendText) {
    // Obsidian treats leading blank lines of the first label as part of its text.
    const from = textSection
      ? (textSection.records.size ? textSection.to : textSection.from)
      : (linkSection ? sectionStart(linkSection) : beforeAttachments)
    insertions.set(from, textSection ? appendText : `## Text Elements${eol}${appendText}`)
  }
  if (appendLinks) {
    const from = linkSection?.to ?? beforeAttachments
    insertions.set(from, (insertions.get(from) ?? '') + (linkSection ? appendLinks : `## Element Links${eol}${appendLinks}`))
  }
  if (patch.attachments?.length) {
    const from = attachmentSection?.to ?? dataEnd
    const records = patch.attachments.map(({ id, target }) => `${id}: [[${target}]]${eol}${eol}`).join('')
    insertions.set(from, (insertions.get(from) ?? '') + (attachmentSection ? '' : `## Embedded Files${eol}`) + records)
  }
  for (const [from, text] of insertions) {
    const separator = from === textSection?.from || source.slice(0, from).endsWith(eol + eol) || text.startsWith('## ') ? '' : eol
    edits.push({ from, to: from, text: separator + text })
  }

  const order = patch.order ?? []
  const sorted = order.length ? [...new Map([...order.map(id => [id, elements.get(id)] as const), ...elements]).values()].filter((element): element is Element => element !== undefined) : [...elements.values()]
  const json = JSON.stringify({ ...stored, elements: sorted }, null, '\t')
  edits.push({
    from: payload.from,
    to: payload.to,
    text: (payload.kind === 'json' ? json.replace(/\n/g, eol) : lz.compressToBase64(json)) + eol,
  })
  return edits
}

export function newDrawing(): string {
  return [
    '---', 'excalidraw-plugin: parsed', '---', '', '# Excalidraw Data', '', '## Text Elements',
    '%%', '## Drawing', '```json',
    JSON.stringify({
      type: 'excalidraw', version: 2, source: 'vsidian-excalidraw', elements: [],
      appState: { viewBackgroundColor: '#ffffff' }, files: {},
    }),
    '```', '%%', '',
  ].join('\n')
}
