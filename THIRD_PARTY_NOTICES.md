# Third-party notices

Vsidian Excalidraw ships the original Excalidraw SDK and its font assets from the
npm distribution of `@excalidraw/excalidraw` 0.18.1. The build removes the SDK's
CDN font fallback in favor of those local assets. The Liberation Sans face
comes from the [Liberation Fonts 2.1.5 release](https://github.com/liberationfonts/liberation-fonts/releases/tag/2.1.5)
(OFL 1.1) instead of the legacy font in the SDK archive.

- [Excalidraw 0.18.1](https://github.com/excalidraw/excalidraw/tree/v0.18.1) (MIT)
- [React and React DOM](https://github.com/facebook/react) (MIT)
- [lz-string](https://github.com/pieroxy/lz-string) (MIT)
- [pako 2.0.3](https://github.com/nodeca/pako) (MIT and zlib)
- [yaml](https://github.com/eemeli/yaml) (ISC)
- [markdown-it 15.0.3](https://github.com/markdown-it/markdown-it) (MIT)
- [PDF.js 6.4.299](https://github.com/mozilla/pdf.js) (Apache-2.0)
- [Vsidian add-on SDK build bridge](https://github.com/ONEGAYI/vsidian/blob/fdd71d995157a4450fac587e624cdec926b6e790/test/fixtures/addon-v02/sdk/sdkBridge.mjs) (MIT)

See [licenses/](licenses/) for the dependency and font notices. The bundled JS license
files next to the build artifacts also preserve upstream license comments.
The official Obsidian community plugin is used only by the native interoperability tests.
