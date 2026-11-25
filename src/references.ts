import MarkdownIt from 'markdown-it'

type Rect = [number, number, number, number]
type LocalTarget =
  | { kind: 'note'; path: string; fragment: string }
  | { kind: 'pdf'; path: string; fragment: string; page: number; rect?: Rect }

export type LocalContent =
  | { kind: 'note'; html: string }
  | { kind: 'pdf'; file: string; page: number; rect?: Rect }

export function localReference(raw: string, wiki = false): LocalTarget | undefined {
  const text = wiki ? /^\[\[([^\]\r\n]+)\]\]$/.exec(raw)?.[1] : raw
  if (!text) return
  const [key] = text.split('|', 1)
  const hash = key.indexOf('#')
  const path = (hash === -1 ? key : key.slice(0, hash)).trim()
  const fragment = hash === -1 ? '' : key.slice(hash + 1).trim()
  if (!path || path.startsWith('/') || /[:\\\0*?[\]{}]/.test(path)) return
  const suffix = /\.[^/]+$/.exec(path)?.[0].toLowerCase()
  if (suffix === '.pdf') {
    const query = new URLSearchParams(fragment)
    const page = query.get('page') ?? '1'
    if (!/^\d+$/.test(page) || Number(page) < 1 || !Number.isSafeInteger(Number(page))) return
    const rect = query.get('rect')?.split(',').filter(value => value.trim()).map(Number)
    return { kind: 'pdf', path, fragment, page: Number(page),
      ...(rect?.length === 4 && rect.every(Number.isFinite) ? { rect: rect as Rect } : {}) }
  }
  if (suffix === '.md' || !suffix || suffix === '.excalidraw' || wiki) {
    return { kind: 'note', path: suffix === '.md' ? path : path + '.md', fragment }
  }
}

const md = new MarkdownIt({ html: false, linkify: false, typographer: false })
md.renderer.rules.link_open = () => '<span>'
md.renderer.rules.link_close = () => '</span>'
md.renderer.rules.image = (tokens, index) => md.utils.escapeHtml(tokens[index].content)

export function notePreview(source: string, fragment: string) {
  const content = source.replace(/^(?:\uFEFF)?---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/, '')
  let selected = content
  if (fragment) {
    const tokens = md.parse(content, {})
    const lines = content.split(/\r?\n/)
    if (fragment.startsWith('^')) {
      if (!/^\^[\w-]+$/.test(fragment)) return
      const marker = new RegExp('(?:^|[ \\t])' + '\\' + fragment + '[ \\t]*$')
      const paragraph = tokens.find(token => token.type === 'paragraph_open' && token.map &&
        lines.slice(...token.map).some(line => marker.test(line)))
      if (!paragraph?.map) return
      selected = lines.slice(...paragraph.map).map(line => line.replace(marker, '')).join('\n')
      if (!selected.trim()) {
        const previous = tokens.filter(token => token.level === 0 && token.map && token.map[1] <= paragraph.map![0]).at(-1)
        if (!previous?.map) return
        selected = lines.slice(...previous.map).join('\n')
      }
    } else {
      const heading = tokens.findIndex((token, i) => token.type === 'heading_open' &&
        tokens[i + 1].children?.map(child => child.content).join('').trim().normalize().toLowerCase() === fragment.normalize().toLowerCase())
      if (heading === -1) return
      const head = tokens[heading]
      const next = tokens.slice(heading + 1).find(token => token.type === 'heading_open' && token.tag <= head.tag)
      selected = lines.slice(head.map![0], next?.map?.[0]).join('\n')
    }
  }
  return { html: md.render(selected) }
}
