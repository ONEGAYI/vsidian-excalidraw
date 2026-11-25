import { cp, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { build } from 'esbuild'

await build({
  entryPoints: ['src/extension.ts'], outfile: 'dist/extension.cjs', external: ['vscode'],
  bundle: true, platform: 'node', format: 'cjs', target: 'node18', minify: true,
  legalComments: 'linked',
})
let fontFallbackRemoved = false
await build({
  entryPoints: ['src/board.tsx'], outdir: 'dist/board', entryNames: '[name]',
  bundle: true, platform: 'browser', format: 'esm', target: 'chrome114', minify: true,
  conditions: ['production'], define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' }, legalComments: 'linked',
  plugins: [{
    name: 'local-fonts',
    setup(builder) {
      // 0.18.1 appends the CDN even with EXCALIDRAW_ASSET_PATH. The Webview
      // ships the same font files locally and intentionally has no CDN access.
      builder.onLoad({ filter: /@excalidraw[\\/]excalidraw[\\/]dist[\\/]prod[\\/]chunk-[^\\/]+\.js$/ }, async ({ path }) => {
        const source = await readFile(path, 'utf8')
        const contents = source
          .replace(/return \w+\.push\(new URL\(\w+,\w+\.ASSETS_FALLBACK_URL\)\),(\w+)/, 'return $1')
          .replace('./fonts/Liberation/LiberationSans-Regular.woff2', './fonts/Liberation/LiberationSans-Regular.ttf')
        if (contents !== source) fontFallbackRemoved = true
        return { contents }
      })
    },
  }],
})
if (!fontFallbackRemoved) throw new Error('The bundled Excalidraw font source changed; check the offline font path')
const from = 'node_modules/@excalidraw/excalidraw/dist/prod'
const to = 'dist/board'
await mkdir(to, { recursive: true })
await cp(from + '/fonts', to + '/fonts', {
  recursive: true, filter: file => path.basename(file) !== 'LiberationSans-Regular.woff2',
})
await cp('assets/LiberationSans-Regular.ttf', to + '/fonts/Liberation/LiberationSans-Regular.ttf')
for (const name of ['subset-worker.chunk.js', 'subset-shared.chunk.js']) await cp(from + '/' + name, to + '/' + name)
