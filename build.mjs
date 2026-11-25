import { cp, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { build } from 'esbuild'
import { createSdkBridgePlugin } from './sdkBridge.mjs'

await build({
  entryPoints: ['src/extension.ts'], outfile: 'dist/extension.cjs', external: ['vscode'],
  bundle: true, platform: 'node', format: 'cjs', target: 'node18', minify: true,
  legalComments: 'linked',
})
let fontFallbackRemoved = false
await build({
  entryPoints: ['src/board.tsx', 'src/preview-art.ts'], outdir: 'dist/board', entryNames: '[name]',
  bundle: true, splitting: true, platform: 'browser', format: 'esm', target: 'chrome114', minify: true,
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
await build({
  entryPoints: ['src/preview.ts'], outfile: 'dist/preview.js',
  bundle: true, platform: 'browser', format: 'iife', target: 'chrome114', minify: true,
  plugins: [createSdkBridgePlugin()],
  legalComments: 'linked',
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

// VS Code 1.82 runs Chromium 114; these two APIs are not in the PDF.js legacy polyfill set.
const pdfCompat = { js: `if (!Promise.withResolvers) Promise.withResolvers = function () { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } };
if (!ReadableStream.prototype[Symbol.asyncIterator]) ReadableStream.prototype[Symbol.asyncIterator] = async function* () { const reader = this.getReader(); try { for (;;) { const { done, value } = await reader.read(); if (done) return; yield value } } finally { reader.releaseLock() } };` }
const pdf = 'node_modules/pdfjs-dist'
for (const [entry, name, format] of [
  ['src/pdf-render.ts', 'pdf-render', 'esm'],
  [pdf + '/legacy/build/pdf.worker.mjs', 'pdf-worker', 'iife'],
]) await build({
  entryPoints: [entry], outfile: to + '/' + name + '.js', format,
  bundle: true, platform: 'browser', target: 'chrome114', minify: true, banner: pdfCompat,
  legalComments: name === 'pdf-worker' ? 'inline' : 'linked',
})
for (const folder of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  await cp(pdf + '/' + folder, to + '/pdf-assets/' + folder, { recursive: true })
}
