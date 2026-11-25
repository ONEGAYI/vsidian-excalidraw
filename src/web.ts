export function webLink(raw: string): URL | undefined {
  if (!/^https?:\/\//i.test(raw)) return
  let url: URL
  try {
    url = new URL(raw)
  } catch (error) {
    if (!(error instanceof TypeError)) throw error
    return
  }
  if (url.username || url.password) return
  return url
}

export function allowedWebOrigins(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const origins = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const url = webLink(item.trim())
    // Only exact origins become CSP source expressions, never wildcard hosts or arbitrary tokens.
    if (url?.protocol === 'https:' && /^(?:[a-z\d.-]+|\[[a-f\d:]+\])$/i.test(url.hostname)
      && url.href === url.origin + '/') origins.add(url.origin)
  }
  return [...origins]
}
