import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { newDrawing, readDrawing } from '../src/format.ts'

const [stage, sessionPath, vsidianSource, vscodeExe, vsidianExtension, obsidianExe, pluginSource, installedAddon] = process.argv.slice(2)
if (!stage || !sessionPath || !vsidianSource || !vscodeExe || !vsidianExtension || !obsidianExe || !pluginSource) {
  throw new Error('Usage: node test/native.mjs <stage> <session-dir> <Vsidian-source> <Code.exe> <Vsidian-extension> <Obsidian.exe> <Obsidian-plugin-dir> [addonDir]')
}
const { runTestHost, buildTestHostArgs } = await import(pathToFileURL(path.resolve(vsidianSource, 'test/integration/testHost.mjs')))
const addon = installedAddon ?? fileURLToPath(new URL('..', import.meta.url))
const session = path.resolve(sessionPath)
const runId = randomUUID()
const vault = path.join(session, 'vault')
const pluginId = 'obsidian-excalidraw-plugin'
const cases = ['Compressed.excalidraw.md', 'Plain.md']
const linkedLabel = 'Original [[Readme|Label]]'
const editedLinkedLabel = linkedLabel.replace('Original', 'Edited in Vsidian')
const invariant = 'Original note content — 画板往返'
const asset = 'assets/reference.svg'
const gallery = 'Gallery.md'
const gallerySource = '# Drawing gallery\n\n![[Compressed.excalidraw]]\n\n![[Plain]]\n\n![[Readme]]\n'
const incomplete = 'Incomplete.excalidraw.md'
const incompleteHeading = 'A drawing without scene data'
const incompleteSource = '---\nexcalidraw-plugin: parsed\n---\n\n# ' + incompleteHeading + '\n'
const incompleteGallery = 'Incomplete reference.md'
const localBoard = 'Local references.excalidraw.md'
const localNote = 'Reference.md'
const localPdf = 'assets/pages.pdf'
const slowImageBoard = 'Slow image writes.excalidraw.md'
const sectionMarker = 'Northern section marker'
const blockMarker = 'Portable block marker'
const referencesNote = '# Remote section\n\nDo not show this section\n\n## Selected section\n\n**' + sectionMarker +
  '**\n\n## Example block\n\n' + blockMarker + ' ^portable-block\n\nDo not show this other paragraph\n'
const webBoard = 'Web references.excalidraw.md'
const webAllowed = 'https://allowed.preview.test'
const webDenied = 'https://frame-denied.preview.test'
const webBlocked = 'https://not-allowed.preview.test'
const webInsecure = 'http://allowed.preview.test'
const webTargets = [webAllowed, webDenied, webBlocked, webInsecure]

async function retry(probe, reason, timeout = 30_000) {
  const end = Date.now() + timeout
  do {
    const result = await probe()
    if (result) return result
    await delay(125)
  } while (Date.now() < end)
  throw new Error(reason)
}

async function host(name, executable, args, check, extraEnv = {}) {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  const endpoint = 'http://127.0.0.1:' + port
  let exit
  const running = runTestHost({
    executable, args: [...args, '--remote-debugging-port=' + port, '--disable-gpu',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
    env: { ...process.env, ...extraEnv }, reportPath: path.join(session, name + '-host.log'), timeoutMs: 90_000,
  }).then(code => { exit = code; return code })
  let browser
  let checked = false
  try {
    await retry(async () => {
      if (exit !== undefined) throw new Error(name + ' exited before debug endpoint: ' + exit)
      try {
        return (await fetch(endpoint + '/json/version')).ok
      } catch (error) {
        if (error?.cause?.code !== 'ECONNREFUSED') throw error
        return false
      }
    }, name + ' did not start an isolated debugging endpoint')
    browser = await chromium.connectOverCDP(endpoint, { noDefaults: true })
    await check(browser)
    checked = true
  } catch (error) {
    console.error(name + ' scenario:', error)
    throw error
  } finally {
    if (browser?.isConnected() && exit === undefined) {
      try {
        const cdp = await browser.newBrowserCDPSession()
        void cdp.send('Browser.close').catch(error => {
          if (!String(error).includes('closed')) console.error(error)
        })
      } catch (error) {
        // VS Code exits on its own when the trusted extension tests return.
        if (browser.isConnected() && !String(error).includes('closed')) throw error
      }
    }
    const code = await running
    if (checked) assert.equal(code, 0, name + ' host exited unsuccessfully')
    else if (code !== 0) console.log(name + ' host exit: ' + code + ' (see native host log)')
  }
}

async function obsidian(operation) {
  const profile = path.join(session, 'obsidian-seed')
  await mkdir(profile, { recursive: true })
  await writeFile(path.join(profile, 'obsidian.json'), JSON.stringify({
    vaults: { '11f8ed0ea317d434': { path: vault, ts: Date.now(), open: true } },
  }))
  await host('obsidian-' + stage, obsidianExe, ['--user-data-dir=' + profile, '--disable-accelerated-2d-canvas'], async browser => {
    const page = await retry(() => browser.contexts()[0].pages().find(p => p.url().startsWith('app://obsidian.md/')), 'Obsidian vault window did not appear')
    page.on('pageerror', error => console.error('[Obsidian]', error.message))
    page.on('console', msg => { if (msg.type() === 'error' || msg.type() === 'warning') console.log('[Obsidian]', msg.type(), msg.text().slice(0, 1200)) })
    page.on('dialog', dialog => void dialog.dismiss().catch(error => console.error('[Obsidian dialog]', error.message)))
    await page.waitForFunction(() => globalThis.app?.workspace?.layoutReady, undefined, { timeout: 20000, polling: 125 })
    const identified = await page.evaluate(() => ({
      vault: app.vault.adapter.getBasePath(),
      profile: require('@electron/remote').app.getPath('userData'),
      appVersion: require('@electron/remote').app.getVersion(),
      pluginVersion: app.plugins.manifests['obsidian-excalidraw-plugin']?.version,
    }))
    assert.equal(path.resolve(identified.vault), vault)
    assert.equal(path.resolve(identified.profile), profile)
    assert(identified.pluginVersion, 'Plugin manifest was not loaded from the isolated vault')
    console.log('Obsidian ' + identified.appVersion + ' / Excalidraw ' + identified.pluginVersion, identified.vault)
    console.log('Sandbox plugin state before loading:', await page.evaluate(id => ({
      enabled: [...app.plugins.enabledPlugins], restricted: app.plugins.isEnabled?.() === false,
      plugin: !!app.plugins.plugins[id], notice: document.querySelector('.modal-container')?.textContent?.slice(0, 400),
    }), pluginId))
    if (!await page.evaluate(id => !!app.plugins.plugins[id], pluginId)) {
      console.log('Load via app:', await page.evaluate(async id => {
        if (app.plugins.isEnabled?.() === false) await app.plugins.setEnable(true)
        const result = await app.plugins.enablePluginAndSave(id)
        const plugin = app.plugins.plugins[id]
        return { result, plugin: !!plugin, keys: plugin && Object.keys(plugin).slice(0, 100), ea: !!plugin?.ea }
      }, pluginId))
    }
    await page.waitForFunction(id => app.plugins.plugins[id]?.ea, pluginId, { timeout: 20000, polling: 125 })
    await page.evaluate(id => app.plugins.plugins[id].awaitInit(), pluginId)
    await operation(page)
  })
}

if (stage === 'seed') {
  const config = path.join(vault, '.obsidian')
  const deployed = path.join(config, 'plugins', pluginId)
  await mkdir(deployed, { recursive: true })
  await mkdir(path.join(vault, 'assets'), { recursive: true })
  await cp(pluginSource, deployed, { recursive: true })
  await writeFile(path.join(config, 'community-plugins.json'), JSON.stringify([pluginId]))
  await writeFile(path.join(vault, 'Readme.md'), '# Normal Markdown\n')
  await writeFile(path.join(vault, 'Warmup.excalidraw.md'), newDrawing())
  await writeFile(path.join(vault, asset), '<svg xmlns="http://www.w3.org/2000/svg" width="52" height="36"><rect width="52" height="36" fill="#125dca"/></svg>')
  await obsidian(async page => {
    await page.evaluate(() => app.plugins.plugins['obsidian-excalidraw-plugin']
      .openDrawing(app.vault.getFileByPath('Warmup.excalidraw.md'), 'active-pane', true))
    await page.waitForFunction(() => app.workspace.activeLeaf?.view?.excalidrawAPI?.getSceneElements, undefined, { timeout: 20000, polling: 100 })
    for (const [i, file] of cases.entries()) {
      const label = i === 0 ? linkedLabel : 'Original Label'
      const expected = await page.evaluate(async ({ file, asset, invariant, compressed, label }) => {
        const plugin = app.plugins.plugins['obsidian-excalidraw-plugin']
        plugin.settings.compress = compressed
        plugin.settings.showLinkBrackets = false
        const ea = plugin.ea
        ea.reset()
        ea.style.strokeColor = '#d62224'
        const rectId = ea.addRect(0, 0, 140, 75)
        const labelId = ea.addText(15, 22, label)
        const imageId = await ea.addImage(180, 10, asset)
        const located = await ea.create({ filename: file.replace(/\.md$/, ''), foldername: '', onNewPane: false })
        const created = app.vault.getFileByPath(located)
        if (created.path !== file) await app.fileManager.renameFile(created, file)
        await app.vault.process(created, text => text.replace(/(\r?\n---\r?\n)/, '$1\n' + invariant + '\n\n'))
        if (compressed) await plugin.openDrawing(created, 'active-pane', true)
        return { rectId, labelId, imageId }
      }, { file, asset, invariant, compressed: i === 0, label })
      if (i === 0) {
        await page.waitForFunction(({ file, id }) => app.workspace.activeLeaf?.view?.file?.path === file
          && app.workspace.activeLeaf.view.excalidrawAPI?.getSceneElements().some(e => e.id === id
            && e.originalText?.includes('Label') && !e.originalText.includes('[[')),
        { file, id: expected.labelId }, { polling: 100, timeout: 8000 })
        await page.evaluate(() => app.workspace.activeLeaf.view.forceSave(true, true))
      }
      const source = await readFile(path.join(vault, file), 'utf8')
      const scene = readDrawing(source)
      assert.match(source, new RegExp(invariant))
      assert.equal(scene.payload.kind, i === 0 ? 'compressed-json' : 'json')
      assert(scene.scene.elements.some(e => e.id === expected.labelId && e.originalText === label))
      if (i === 0) {
        const original = scene.stored.elements.find(e => e.id === expected.labelId)
        assert.equal(original.rawText, label)
        assert(!original.originalText.includes('[['), 'The original plugin did not save a parsed label')
      }
      assert.equal(scene.attachments.size, 1)
      await writeFile(path.join(session, file + '.original'), source)
      console.log('PASS: Obsidian generated', file, scene.payload.kind, expected)
    }
  })
} else if (stage === 'references-seed') {
  await writeFile(path.join(vault, localNote), referencesNote)
  await writeFile(path.join(vault, localPdf), fixturePdf())
  let seeded
  await obsidian(async page => {
    await page.evaluate(id => app.plugins.plugins[id]
      .openDrawing(app.vault.getFileByPath('Warmup.excalidraw.md'), 'active-pane', true), pluginId)
    await page.waitForFunction(() => app.workspace.activeLeaf?.view?._loaded &&
      app.workspace.activeLeaf.view.file?.path === 'Warmup.excalidraw.md', undefined, { timeout: 14000 })
    seeded = await page.evaluate(async ({ board, note, pdf, pluginId }) => {
        const plugin = app.plugins.plugins[pluginId]
        plugin.settings.compress = true
        const ea = plugin.ea
        ea.reset()
        ea.setView('active')
        const file = app.vault.getFileByPath(note)
        const section = ea.addEmbeddable(0, 0, 360, 155, undefined, file)
        const block = ea.addEmbeddable(390, 0, 360, 155, undefined, file)
        ea.getElement(section).link = '[[' + note + '#Selected section]]'
        ea.getElement(block).link = '[[' + note + '#^portable-block]]'
        const image = await ea.addImage(40, 190, pdf + '#page=2')
        if (!image) throw new Error('Obsidian did not insert the PDF page')
        const chart = await ea.create({ filename: board.replace(/\.md$/, ''), foldername: '', onNewPane: false })
        if (chart !== board) await app.fileManager.renameFile(app.vault.getFileByPath(chart), board)
        return { section, block, image }
    }, { board: localBoard, note: localNote, pdf: localPdf, pluginId })
  })
  const source = await readFile(path.join(vault, localBoard), 'utf8')
  const drawing = readDrawing(source)
  const pdf = drawing.scene.elements.find(el => el.id === seeded.image)
  assert.equal(drawing.scene.elements.find(el => el.id === seeded.section).link, '[[' + localNote + '#Selected section]]')
  assert.equal(drawing.scene.elements.find(el => el.id === seeded.block).link, '[[' + localNote + '#^portable-block]]')
  assert(drawing.attachments.get(pdf.fileId)?.includes(localPdf + '#page=2'))
  console.log('PASS: official Obsidian plugin produced two note selectors and a PDF page image', seeded)
  await writeFile(path.join(session, localBoard + '.references-original'), source)
} else if (stage === 'web-seed') {
  await obsidian(async page => {
    await page.context().route(/https?:\/\/[^/]+\.preview\.test\//, route => route.abort())
    await page.evaluate(id => app.plugins.plugins[id]
      .openDrawing(app.vault.getFileByPath('Warmup.excalidraw.md'), 'active-pane', true), pluginId)
    await page.waitForFunction(() => app.workspace.activeLeaf?.view?._loaded &&
      app.workspace.activeLeaf.view.file?.path === 'Warmup.excalidraw.md', undefined, { timeout: 14000 })
    await page.evaluate(async ({ board, targets, id }) => {
      const plugin = app.plugins.plugins[id]
      plugin.settings.compress = false
      const ea = plugin.ea
      ea.reset()
      ea.setView('active')
      for (const [i, origin] of targets.entries()) ea.addEmbeddable((i % 2) * 222, Math.floor(i / 2) * 132, 210, 116, origin + '/page')
      const raw = ea.getElement(ea.addRect(0, 270, 180, 65))
      raw.type = 'iframe'
      raw.customData = { generationData: { status: 'done', html: '<p>RAW_FRAME_CONTENT_MUST_NOT_MOUNT</p>' } }
      const chart = await ea.create({ filename: board.replace(/\.excalidraw\.md$/, ''), foldername: '', onNewPane: false })
      if (chart !== board) await app.fileManager.renameFile(app.vault.getFileByPath(chart), board)
    }, { board: webBoard, targets: webTargets, id: pluginId })
  })
  const source = await readFile(path.join(vault, webBoard), 'utf8')
  const contents = readDrawing(source)
  assert.deepEqual(contents.scene.elements.filter(e => e.type === 'embeddable').map(e => e.link), webTargets.map(origin => origin + '/page'))
  assert(contents.stored.elements.some(e => e.type === 'iframe' && e.customData.generationData.html.includes('RAW_FRAME_CONTENT')))
  await writeFile(path.join(session, webBoard + '.web-original'), source)
  console.log('PASS: Obsidian created actual URL elements and an HTML frame in a plain graph')
} else if (['vscode', 'view-selection-vscode', 'create', 'image-import', 'image-batches', 'image-return', 'preview-vscode', 'references-vscode', 'web-vscode'].includes(stage)) {
  if (stage === 'image-batches') {
    await mkdir(vault, { recursive: true })
    await writeFile(path.join(vault, slowImageBoard), newDrawing())
  }
  if (stage === 'preview-vscode') await writeFile(path.join(vault, gallery), gallerySource)
  if (stage === 'preview-vscode') {
    for (const file of cases) await cp(path.join(session, file + '.with-import'), path.join(vault, file))
    const formats = await Promise.all(cases.map(async file => readDrawing(await readFile(path.join(vault, file), 'utf8')).payload.kind))
    assert.deepEqual(formats, ['compressed-json', 'json'], 'A two-format preview test requires one drawing of each encoding')
    await writeFile(path.join(vault, incompleteGallery), '# Reference fallback\n\n![[Incomplete.excalidraw]]\n')
  }
  if (['vscode', 'view-selection-vscode', 'image-import'].includes(stage)) {
    for (const file of cases) await cp(path.join(session, file + '.original'), path.join(vault, file))
  }
  if (stage === 'vscode' || stage === 'preview-vscode') await writeFile(path.join(vault, incomplete), incompleteSource)
  if (stage === 'vscode') {
    await writeFile(path.join(vault, 'Tagged.excalidraw.md'), '---\ntags: [excalidraw]\n---\n\n# A note about Excalidraw\n')
  }
  const scope = path.join(session, stage + '-user')
  await mkdir(path.join(scope, 'User'), { recursive: true })
  await writeFile(path.join(scope, 'User', 'settings.json'), JSON.stringify({
    'workbench.startupEditor': 'none',
    // A narrow Excalidraw view only opens links from their icons, not the artwork.
    'window.zoomLevel': stage === 'references-vscode' ? -1 : 0,
    'security.workspace.trust.enabled': false,
    'window.restoreWindows': 'none', 'files.autoSave': 'off', 'workbench.colorTheme': 'Default Light Modern',
    'files.simpleDialog.enable': true,
  }))
  await host(stage, vscodeExe, buildTestHostArgs({
    workspaceDir: vault, extensionPath: vsidianExtension, extraExtensionPaths: [addon],
    extensionsDir: path.join(session, 'vscode-extensions'), userDataDir: scope,
    testsPath: fileURLToPath(new URL('./vscode-host.cjs', import.meta.url)),
  }).concat('--locale=en'), async browser => {
    const page = await retry(() => browser.contexts()[0].pages().find(p => p.url().includes('workbench')), 'VS Code workbench did not appear')
    page.on('console', msg => { if (msg.type() === 'error' || msg.type() === 'warning') console.log('[workbench]', msg.type(), msg.text().slice(0, 600)) })
    page.on('pageerror', error => console.error('[workbench]', error.message))
    await vscodeFlow(page)
  }, { VSED_SESSION: session, VSED_RUN: runId, VSIDIAN_TEST_HOOKS: '1' })
} else if (stage === 'preview-obsidian') {
  await obsidian(async page => {
    await page.evaluate(async file => {
      const leaf = app.workspace.getLeaf(false)
      await leaf.openFile(app.vault.getFileByPath(file), { state: { mode: 'preview' } })
    }, gallery)
    const draws = page.locator('.markdown-preview-view .excalidraw-embedded-img')
    for (let i = 0; i < cases.length; i++) await draws.nth(i).waitFor({ state: 'visible', timeout: 15000 }).catch(async error => {
      console.error('Obsidian embeds:', await page.locator('.markdown-preview-view').evaluateAll(views =>
        views.map(view => ({ text: view.textContent?.slice(0, 350), embeds: [...view.querySelectorAll('.internal-embed, [class*="excalidraw"]')]
          .map(el => [el.tagName, el.className, el.getAttribute('src')?.slice(0, 100)]).slice(0, 16) }))))
      throw error
    })
    assert.equal(await draws.count(), cases.length)
    for (let i = 0; i < cases.length; i++) {
      const count = await draws.nth(i).locator('svg:visible, img:visible, canvas:visible').count()
        + Number(await draws.nth(i).evaluate(el => el.matches('img,svg,canvas')))
      assert(count > 0, 'Obsidian did not render an image for ' + cases[i])
    }
    await page.getByText('Normal Markdown', { exact: true }).waitFor({ state: 'visible', timeout: 10000 })
    await page.screenshot({ path: path.join(session, 'obsidian-gallery.png') })
    assert.equal(await readFile(path.join(vault, gallery), 'utf8'), gallerySource)
    console.log('PASS: Obsidian reads both unchanged wiki-embeds from the same Markdown note')
  })
} else if (stage === 'references-obsidian') {
  const source = await readFile(path.join(vault, localBoard), 'utf8')
  await obsidian(async page => {
    await page.evaluate(({ pluginId, file }) => app.plugins.plugins[pluginId]
      .openDrawing(app.vault.getFileByPath(file), 'active-pane', true), { pluginId, file: localBoard })
    const activeId = await page.waitForFunction(file =>
      app.workspace.activeLeaf?.view?.file?.path === file &&
      app.workspace.activeLeaf.view.excalidrawAPI?.getSceneElements().some(el => el.type === 'rectangle'),
    localBoard, { timeout: 12000 })
    assert(activeId)
    await retry(() => page.evaluate(hasSecondPdfPage), 'Obsidian did not paint the referenced second PDF page')
    await page.getByText(sectionMarker, { exact: true }).waitFor({ state: 'visible', timeout: 12000 })
    await page.getByText(blockMarker, { exact: true }).waitFor({ state: 'visible', timeout: 12000 })
    await page.screenshot({ path: path.join(session, 'obsidian-local-references.png') })
  })
  assert.equal(await readFile(path.join(vault, localBoard), 'utf8'), source)
  assert.equal(await readFile(path.join(vault, localNote), 'utf8'), referencesNote)
  assert((await readFile(path.join(vault, localPdf))).equals(fixturePdf()))
  console.log('PASS: Obsidian paints both note selectors and PDF page 2 after a Vsidian edit')
} else if (stage === 'web-obsidian') {
  const original = readDrawing(await readFile(path.join(session, webBoard + '.web-original'), 'utf8'))
  await cp(path.join(session, webBoard + '.web-from-vsidian'), path.join(vault, webBoard))
  await obsidian(async page => {
    await page.context().route(/https?:\/\/[^/]+\.preview\.test\//, route => route.abort())
    await page.evaluate(({ id, file }) => {
      const plugin = app.plugins.plugins[id]
      plugin.settings.compress = false
      return plugin.openDrawing(app.vault.getFileByPath(file), 'active-pane', true)
    }, { id: pluginId, file: webBoard })
    const expected = original.scene.elements.filter(element => element.type === 'embeddable').map(el => el.link)
    await page.waitForFunction(({ file, expected }) => {
      const view = app.workspace.activeLeaf?.view
      if (view?.file?.path !== file || !view.excalidrawAPI) return false
      const elements = view.excalidrawAPI.getSceneElements()
      return elements.some(el => el.type === 'rectangle') &&
        expected.every(link => elements.some(el => el.type === 'embeddable' && el.link === link))
    }, { file: webBoard, expected }, { timeout: 12000 })
    await page.screenshot({ path: path.join(session, 'obsidian-web-references.png') })
  })
  const reopened = readDrawing(await readFile(path.join(vault, webBoard), 'utf8'))
  // The official plugin normalizes indices, element versions and the default scale on open.
  // Vsidian's own byte-for-byte preservation is checked before handing the file back.
  const portable = ({ index, updated, version, versionNonce, scale = [1, 1], ...element }) => ({ ...element, scale })
  for (const el of original.stored.elements) assert.deepEqual(portable(reopened.stored.elements.find(e => e.id === el.id)), portable(el))
  assert.equal(reopened.payload.kind, original.payload.kind)
  console.log('PASS: Obsidian reopened Vsidian’s edit with all original URLs and frame data intact')
} else if (stage === 'reopen' || stage === 'new' || stage === 'image-reopen') {
  const selected = stage === 'new' ? ['Drawing.excalidraw.md'] : cases
  for (const file of selected) {
    const suffix = stage === 'image-reopen' ? '.with-import' : '.from-vsidian'
    await cp(path.join(session, file + suffix), path.join(vault, file))
  }
  await obsidian(async page => {
    for (const file of selected) {
      const expectedText = stage === 'new' ? 'Created in Vsidian · 双平台'
        : stage === 'image-reopen' ? file === cases[0] ? linkedLabel : 'Original Label'
        : file === cases[0] ? editedLinkedLabel : 'Edited in Vsidian'
      await page.evaluate(file => {
        const plugin = app.plugins.plugins['obsidian-excalidraw-plugin']
        const drawing = app.vault.getFileByPath(file)
        plugin.openDrawing(drawing, 'active-pane', true)
      }, file)
      await page.waitForFunction(({ file, expectedText }) => app.workspace.activeLeaf?.view?.file?.path === file
        && app.workspace.activeLeaf.view.excalidrawAPI?.getSceneElements().some(e => e.type === 'text' && (e.rawText ?? e.originalText) === expectedText),
      { file, expectedText }, { polling: 100, timeout: 8000 }).catch(async error => {
        console.error('Obsidian scene while waiting for the label:', await page.evaluate(() => {
          const view = app.workspace.activeLeaf?.view
          return {
            file: view?.file?.path, type: view?.getViewType(),
            labels: view?.excalidrawAPI?.getSceneElements().filter(e => e.type === 'text')
              .map(e => ({ raw: e.rawText, original: e.originalText, text: e.text })),
          }
        }))
        throw error
      })
      const welcome = page.locator('.modal-container').filter({ hasText: /欢迎使用 Excalidraw|Welcome to Excalidraw/ })
      if (await welcome.isVisible()) {
        await page.keyboard.press('Escape')
        await welcome.waitFor({ state: 'hidden', timeout: 4000 })
      }
      await page.evaluate(id => {
        const ea = app.plugins.plugins[id].ea
        ea.setView('active')
        ea.viewZoomToElements(false, ea.getViewElements())
      }, pluginId)
      const snapshot = await page.evaluate(() => {
        const view = app.workspace.activeLeaf.view
        return { type: view.getViewType(), elements: view.excalidrawAPI.getSceneElements().map(e => ({
          id: e.id, type: e.type, text: e.rawText ?? e.originalText, fileId: e.fileId,
        })), files: Object.keys(view.excalidrawAPI.getFiles()) }
      })
      assert.equal(snapshot.type, 'excalidraw')
      if (stage === 'reopen' || stage === 'image-reopen') {
        const saved = readDrawing(await readFile(path.join(vault, file), 'utf8'))
        assert.deepEqual(snapshot.elements.map(e => e.id).sort(), saved.scene.elements.filter(e => !e.isDeleted).map(e => e.id).sort())
        assert(snapshot.elements.some(e => e.type === 'text' && e.text === expectedText))
        assert.equal(snapshot.elements.length, 4)
        const imageIds = snapshot.elements.filter(e => e.type === 'image').map(e => e.fileId)
        assert.equal(imageIds.length, stage === 'image-reopen' ? 2 : 1)
        await page.waitForFunction(ids => ids.every(id => id in app.workspace.activeLeaf.view.excalidrawAPI.getFiles()),
          imageIds, { polling: 100 })
        await retry(() => page.evaluate(readPaint, stage === 'image-reopen'), 'Obsidian did not paint the chart and linked images after reopening')
      } else {
        assert(snapshot.elements.some(e => e.type === 'text' && e.text === 'Created in Vsidian · 双平台'))
      }
      await page.screenshot({ path: path.join(session, 'obsidian-' + file + '.png') })
      console.log('PASS: Obsidian reopened', file, snapshot.elements)
      const continued = await page.evaluate(async ({ id, compressed }) => {
        const plugin = app.plugins.plugins[id]
        plugin.settings.compress = compressed
        const ea = plugin.ea
        ea.reset()
        ea.setView('active')
        const element = ea.addEllipse(280, 120, 80, 50)
        return await ea.addElementsToView(false, false, true) ? element : null
      }, { id: pluginId, compressed: file.startsWith('Compressed') })
      assert(continued)
      await page.waitForFunction(id => app.workspace.activeLeaf.view.excalidrawAPI.getSceneElements().some(e => e.id === id && e.type === 'ellipse'),
        continued, { polling: 100, timeout: 8000 })
      await page.evaluate(() => app.workspace.activeLeaf.view.forceSave(true, true))
      const result = await retry(async () => {
        const saved = readDrawing(await readFile(path.join(vault, file), 'utf8'))
        return saved.scene.elements.some(element => element.id === continued && element.type === 'ellipse') && saved
      }, 'Obsidian could not continue editing ' + file)
      assert(result.scene.elements.length >= snapshot.elements.length + 1)
      if (stage === 'image-reopen') {
        for (const { fileId } of snapshot.elements.filter(element => element.type === 'image')) assert(result.attachments.has(fileId))
      }
      console.log('PASS: Obsidian continued editing and saved the same file', file)
    }
  })
} else {
  throw new Error('Unknown stage: ' + stage)
}

async function vscodeFlow(page) {
  const prefix = 'vscode-' + runId
  const ready = await retry(() => readJson(path.join(session, prefix + '-ready')), 'VS Code did not activate the two extensions')
  console.log('VS Code ' + ready.vscode + ' / Vsidian ' + ready.vsidian)
  let requestNo = 0
  const command = async (action, name, value) => {
    const id = ++requestNo
    const request = path.join(session, prefix + '-req-' + id)
    await writeFile(request + '.tmp', JSON.stringify({ action, name, value }))
    await rename(request + '.tmp', request)
    return retry(() => readJson(path.join(session, prefix + '-res-' + id)), 'VS Code did not acknowledge ' + action + ' ' + name)
  }
  const hasView = async (view, file) => retry(async () => {
    const snapshot = await command('snapshot', file)
    return snapshot.active === view && snapshot.activePath &&
      path.relative(snapshot.activePath, path.join(vault, file)) === '' && snapshot
  }, 'VS Code did not activate ' + view + ' for ' + file, 10_000)
  const frameWith = (locator) => retry(async () => {
    for (const frame of page.frames()) {
      if (!await frame.locator(locator).first().isVisible()) continue
      let ancestor = frame
      let visible = true
      while (ancestor.parentFrame()) {
        if (!(await (await ancestor.frameElement()).isVisible())) {
          visible = false
          break
        }
        ancestor = ancestor.parentFrame()
      }
      if (visible) return frame
    }
  }, 'No visible frame: ' + locator)
  const markdownView = 'onegayi.vsidian.editor'
  const boardView = 'onegayi.vsidian-excalidraw.board'

  if (stage === 'view-selection-vscode') {
    const file = cases[1]
    await command('default', file)
    await hasView(boardView, file)
    const originalBoard = await frameWith('.board-toolbar')
    await retry(() => originalBoard.evaluate(readPaint), 'The default view did not paint the drawing')
    await command('source-beside', file)
    await page.getByRole('button', { name: /Switch Vsidian to live preview/i }).click({ timeout: 5000 })
    await hasView(markdownView, file)
    const markdown = await frameWith('.cm-content')
    await markdown.getByText(invariant, { exact: true }).first().waitFor({ state: 'visible', timeout: 5000 })
    await hasView(markdownView, file)
    assert.deepEqual((await command('group-views')).views, [boardView, markdownView])
    await page.getByRole('button', { name: /Open in Excalidraw Board/ }).click({ timeout: 5000 })
    await hasView(boardView, file)
    await command('reopen-with')
    await page.locator('.quick-input-widget').getByLabel('Vsidian', { exact: true }).click({ timeout: 5000 })
    await hasView(markdownView, file)
    await (await frameWith('.cm-content')).getByText(invariant, { exact: true }).first().waitFor({ state: 'visible', timeout: 5000 })
    assert.deepEqual((await command('group-views')).views, [boardView, markdownView])
    await command('close-left-group')
    await hasView(markdownView, file)
    await (await frameWith('.cm-content')).getByText(invariant, { exact: true }).first().waitFor({ state: 'visible', timeout: 5000 })
    assert.deepEqual((await command('group-views')).views, [markdownView])
    await command('close-active')
    await command('default', file)
    await hasView(boardView, file)
    await command('stop')
    console.log('PASS: both explicit Markdown entries leave the other group on its board')
    return
  }

  if (stage === 'web-vscode') {
    const original = await readFile(path.join(session, webBoard + '.web-original'), 'utf8')
    await writeFile(path.join(vault, webBoard), original)
    const requests = []
    await page.context().route(/https?:\/\/[^/]+\.preview\.test\//, route => {
      const target = new URL(route.request().url())
      requests.push(target.href)
      if (target.origin === webDenied) return route.abort('blockedbyresponse')
      return route.fulfill({ status: 200, contentType: 'text/html',
        body: '<meta charset="utf-8"><h1>Sandboxed page loaded</h1>' })
    })
    await command('web-policy-set', undefined, [])
    await command('board', webBoard)
    await hasView(boardView, webBoard)
    let frame = await frameWith('.board-toolbar')
    const card = origin => frame.locator('section[data-web-origin="' + origin + '"]')
    const open = (origin) => card(origin).getByRole('button', { name: 'Open in browser', exact: true })
    const load = (origin) => card(origin).getByRole('button', { name: 'Load preview', exact: true })
    for (const origin of webTargets) {
      await open(origin).waitFor({ state: 'visible', timeout: 6000 })
      assert.equal(await load(origin).count(), 0)
    }
    assert.equal(await frame.locator('.excalidraw iframe').count(), 0)
    assert.deepEqual(requests, [])
    console.log('PASS: default link cards and raw HTML generate no web requests')
    const policy = [webAllowed, webDenied]
    const stored = await command('web-policy-set', undefined, policy)
    assert.equal(stored.outcome?.ok, true, JSON.stringify(stored))
    assert.deepEqual((await command('web-policy-get')).values.webPreviewOrigins, policy)
    await command('web-policy-show')
    const settings = await frameWith('.vsidian-settings-sidebar')
    await settings.locator('.vsidian-settings-sidebar').getByRole('button', { name: 'Vsidian Excalidraw', exact: true }).click({ timeout: 6000 })
    await settings.getByText('Allowed web preview origins', { exact: true }).waitFor({ state: 'visible', timeout: 5000 })
    assert.deepEqual(await settings.locator('.vsidian-addons-array input').evaluateAll(inputs => inputs.map(input => input.value)), policy)
    await command('web-policy-close')
    await command('board', webBoard)
    await command('close-active')
    await command('board', webBoard)
    await hasView(boardView, webBoard)
    frame = await frameWith('.board-toolbar')
    for (const origin of policy) await load(origin).waitFor({ state: 'visible', timeout: 6000 })
    for (const origin of [webBlocked, webInsecure]) assert.equal(await load(origin).count(), 0)
    assert.deepEqual(requests, [])
    await load(webAllowed).click()
    const allowed = card(webAllowed).locator('iframe')
    assert.equal(await allowed.getAttribute('sandbox'), 'allow-scripts')
    assert.equal(await allowed.getAttribute('referrerpolicy'), 'no-referrer')
    const sandboxedPage = card(webAllowed).frameLocator('iframe').getByText('Sandboxed page loaded', { exact: true })
    await sandboxedPage.waitFor({ state: 'visible', timeout: 10000 })
    const child = page.frames().find(candidate => candidate.url() === webAllowed + '/page')
    assert(child)
    await child.evaluate(() => parent.postMessage({ kind: 'web-policy', origins: [] }, '*'))
    assert(await sandboxedPage.isVisible(), 'A child preview must not be able to alter the board policy')
    await Promise.all([
      page.waitForEvent('requestfailed', { predicate: request => request.url() === webDenied + '/page', timeout: 5000 }),
      load(webDenied).click(),
    ])
    await open(webDenied).waitFor({ state: 'visible', timeout: 5000 })
    assert(await sandboxedPage.isVisible(), 'A child preview must not be able to alter the board policy')
    assert.deepEqual([...new Set(requests)].sort(), policy.map(origin => origin + '/page').sort())
    await page.screenshot({ path: path.join(session, 'vscode-web-references.png') })
    await command('web-policy-set', undefined, [])
    await retry(async () => await frame.locator('.excalidraw iframe').count() === 0, 'Revoking the allowlist did not close the embedded pages')
    console.log('PASS: allowlisted HTTPS opt-in loads a sandboxed page, denied framing retains a browser fallback, and revocation unloads previews')
    const toolbar = frame.locator('.board-toolbar')
    await toolbar.getByRole('button', { name: 'Edit drawing', exact: true }).click()
    const bounds = await frame.locator('.excalidraw').boundingBox()
    assert(bounds)
    const x = bounds.x + bounds.width - 105, y = bounds.y + 125
    await page.mouse.click(x, y)
    await page.keyboard.press('r')
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + 40, y + 52, { steps: 5 })
    await page.mouse.up()
    const save = toolbar.getByRole('button', { name: 'Save', exact: true })
    await retry(() => save.isEnabled(), 'The new shape could not be saved')
    await save.click()
    const saved = await retry(async () => {
      const drawing = readDrawing(await readFile(path.join(vault, webBoard), 'utf8'))
      return drawing.stored.elements.some(e => e.type === 'rectangle') && drawing
    }, 'The web drawing edit was not saved')
    for (const el of readDrawing(original).stored.elements) assert.deepEqual(saved.stored.elements.find(e => e.id === el.id), el)
    assert.equal(saved.payload.kind, 'json')
    await cp(path.join(vault, webBoard), path.join(session, webBoard + '.web-from-vsidian'))
    console.log('PASS: saving beside web cards preserved the original URL and raw HTML metadata')
    await command('stop')
    return
  }

  if (stage === 'references-vscode') {
    const original = await readFile(path.join(session, localBoard + '.references-original'), 'utf8')
    await writeFile(path.join(vault, localBoard), original)
    const before = readDrawing(original)
    await command('board', localBoard)
    await hasView(boardView, localBoard)
    let frame = await frameWith('.board-toolbar')
    const button = name => frame.locator('.board-toolbar').getByRole('button', { name, exact: true })
    await frame.getByText(sectionMarker, { exact: true }).waitFor({ state: 'visible', timeout: 6000 })
    await frame.getByText(blockMarker, { exact: true }).waitFor({ state: 'visible', timeout: 6000 })
    assert.equal(await frame.getByText(/Do not show this/).filter({ visible: true }).count(), 0)
    const pdfHit = await retry(() => frame.evaluate(hasSecondPdfPage), 'Vsidian did not paint the referenced second PDF page')
    await page.screenshot({ path: path.join(session, 'vscode-local-references.png') })
    console.log('PASS: Vsidian paints both resolved note selections and PDF page 2')
    const paintedCanvas = frame.locator('.excalidraw canvas').nth(pdfHit.canvas)
    const pdfCanvas = await paintedCanvas.boundingBox()
    assert(pdfCanvas, 'The painted PDF canvas was no longer visible')
    const pdfX = pdfCanvas.x + pdfCanvas.width * pdfHit.x
    const pdfY = pdfCanvas.y + pdfCanvas.height * pdfHit.y
    await page.mouse.move(pdfX, pdfY)
    await retry(() => paintedCanvas.evaluate((canvas, { x, y }) => {
      const box = canvas.getBoundingClientRect()
      const hit = document.elementFromPoint(box.left + box.width * x, box.top + box.height * y)
      return hit && getComputedStyle(hit).cursor === 'pointer'
    }, pdfHit), 'The painted PDF did not expose a source link at its visible artwork', 4000)
    await page.mouse.click(pdfX, pdfY)
    await retry(async () => {
      const active = await command('active')
      return active.activePath && path.relative(active.activePath, path.join(vault, localPdf)) === ''
    }, 'Clicking the PDF preview did not open its original attachment', 6000).catch(async error => {
      const notices = await page.locator('.notification-toast').allTextContents()
      console.error('VS Code after following the PDF link:', await command('active'), notices)
      throw error
    })
    await command('board', localBoard)
    await hasView(boardView, localBoard)
    frame = await frameWith('.board-toolbar')
    await frame.getByRole('button', { name: 'Open source: ' + localNote + '#Selected section', exact: true }).click()
    await hasView(markdownView, localNote)
    assert.equal((await command('snapshot', localNote)).source, referencesNote)
    await command('board', localBoard)
    await hasView(boardView, localBoard)
    frame = await frameWith('.board-toolbar')
    await button('Edit drawing').click()
    const bounds = await frame.locator('.excalidraw').boundingBox()
    assert(bounds)
    const x = bounds.x + bounds.width - 150, y = bounds.y + bounds.height - 190
    await page.mouse.click(x, y)
    await page.keyboard.press('r')
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + 50, y + 65, { steps: 6 })
    await page.mouse.up()
    await retry(() => button('Save').isEnabled(), 'A new rectangle next to the previews did not become saveable')
    await button('Save').click()
    const saved = await retry(async () => {
      const drawing = readDrawing(await readFile(path.join(vault, localBoard), 'utf8'))
      return drawing.stored.elements.some(el => el.type === 'rectangle') && drawing
    }, 'Vsidian did not save the edit alongside the embeds')
    assert.equal(saved.payload.kind, before.payload.kind)
    assert.deepEqual(saved.attachments, before.attachments)
    for (const el of before.stored.elements.filter(e => e.type === 'embeddable' || e.type === 'image')) {
      assert.deepEqual(saved.stored.elements.find(e => e.id === el.id), el)
    }
    assert.deepEqual(saved.stored.files, before.stored.files)
    assert.equal(await readFile(path.join(vault, localNote), 'utf8'), referencesNote)
    assert((await readFile(path.join(vault, localPdf))).equals(fixturePdf()))
    console.log('PASS: opening the source and saving a new shape left each original reference and source file unchanged')
    await command('stop')
    return
  }

  if (stage === 'preview-vscode') {
    page.on('requestfailed', req => console.error('[preview resource]', req.failure()?.errorText, req.url().slice(0, 420)))
    const selectLive = async frame => {
      const toLive = frame.getByRole('button', { name: 'Switch to live preview', exact: true })
      if (await toLive.isVisible()) await toLive.click({ timeout: 5000 })
      await frame.getByRole('button', { name: 'Switch to reading view', exact: true }).waitFor({ state: 'visible', timeout: 5000 })
    }
    await command('markdown', incompleteGallery)
    await hasView(markdownView, incompleteGallery)
    const fallback = await frameWith('.vsidian-view-toggle')
    await selectLive(fallback)
    const ordinaryContent = fallback.locator('.vsidian-embed-card').getByText(incompleteHeading).filter({ visible: true })
    await ordinaryContent.first().waitFor({ state: 'visible', timeout: 5000 })
    await fallback.getByRole('button', { name: 'Switch to reading view', exact: true }).click()
    await fallback.locator('.vsidian-view-reading .vsidian-embed-card').getByText(incompleteHeading, { exact: true })
      .filter({ visible: true }).waitFor({ state: 'visible', timeout: 5000 })
    assert.equal((await command('snapshot', incomplete)).source, incompleteSource)
    console.log('PASS: an incomplete drawing is rendered as Markdown in Live and Reading')
    const sources = await Promise.all(cases.map(name => readFile(path.join(vault, name), 'utf8')))
    await command('markdown', gallery)
    await hasView(markdownView, gallery)
    const frame = await frameWith('.vsidian-view-toggle')
    await selectLive(frame)
    for (const [i, mode] of ['Live', 'Reading'].entries()) {
      const toggle = frame.getByRole('button', { name: i === 0 ? 'Switch to reading view' : 'Switch to live preview', exact: true })
      const draws = frame.locator('.vsidian-embed-card img[data-excalidraw-preview]:visible')
      await retry(async () => {
        if (await draws.count() !== cases.length) return false
        const painted = await draws.evaluateAll(async images => {
          return images.map(image => {
            if (!image.complete || !image.naturalWidth || !image.naturalHeight) return false
            const canvas = document.createElement('canvas')
            canvas.width = 240
            canvas.height = 160
            const ctx = canvas.getContext('2d')
            ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
            const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
            let red = 0, blue = 0, green = 0
            for (let p = 0; p < data.length; p += 4) {
              const [r,g,b,a] = data.subarray(p, p + 4)
              if (a > 180 && r > 160 && g < 80 && b < 80) red++
              if (a > 180 && b > 155 && r < 60 && g > 60 && g < 125) blue++
              if (a > 180 && g > 150 && r < 60 && b > 45 && b < 120) green++
            }
            return red > 25 && blue > 50 && green > 50
          }).every(Boolean)
        })
        return painted && (await frame.getByText('Normal Markdown', { exact: true }).filter({ visible: true }).count()) > 0
      }, mode + ' did not paint compressed and plain drawing embeds with their original and imported attachments', 12000).catch(async error => {
        console.error('Preview cards:', await frame.locator('.vsidian-embed-card').evaluateAll(cards => cards.map(card => ({
          text: card.textContent?.slice(0, 230),
          images: [...card.querySelectorAll('img')].map(img => [img.alt, img.complete, img.naturalWidth, img.naturalHeight]),
        }))))
        await page.screenshot({ path: path.join(session, 'vscode-gallery-failure.png') })
        throw error
      })
      assert.equal((await command('snapshot', gallery)).source, gallerySource)
      await page.screenshot({ path: path.join(session, 'vscode-gallery-' + mode.toLowerCase() + '.png') })
      console.log('PASS: ' + mode + ' paints two drawings with attachments and leaves the normal note embed in place')
      if (i === 0) await toggle.click({ timeout: 5000 })
    }
    await frame.locator('img[data-excalidraw-preview]:visible').first().click()
    await hasView(boardView, cases[0])
    assert.equal((await command('snapshot', cases[0])).source, sources[0])
    assert.equal((await command('snapshot', cases[1])).source, sources[1])
    console.log('PASS: preview opens the source board without rewriting any note')
    await command('stop')
    return
  }

  if (stage === 'create') {
    await createFlow(page, command, frameWith, hasView)
    await command('stop')
    return
  }

  if (stage === 'image-batches') {
    const file = slowImageBoard
    const bytes = 5 * 1024 * 1024
    await command('board', file)
    await hasView(boardView, file)
    const frame = await frameWith('.board-toolbar')
    const button = name => frame.locator('.board-toolbar').getByRole('button', { name, exact: true })
    await button('Edit drawing').click()
    await frame.evaluate(async size => {
      const swatch = document.createElement('canvas')
      swatch.width = 64
      swatch.height = 48
      const ctx = swatch.getContext('2d')
      const files = []
      for (const color of ['#19ba50', '#2266cc']) {
        ctx.fillStyle = color
        ctx.fillRect(0, 0, swatch.width, swatch.height)
        const png = await new Promise(resolve => swatch.toBlob(resolve, 'image/png'))
        // Pad after IEND to control the transport size without expensive pixel decoding.
        files.push(new File([png, new Uint8Array(size - png.size)], color + '.png', { type: 'image/png' }))
      }
      const decoded = new Set()
      const decode = Image.prototype.decode
      Image.prototype.decode = async function () {
        await decode.call(this)
        if (this.src.startsWith('data:image/png;base64,') && this.src.length > size) decoded.add(this.src.slice(0, 512))
      }
      const state = window.imageBatches = {
        decoded, failures: [],
        send(method, ...indexes) {
          const transfer = new DataTransfer()
          for (const index of indexes) transfer.items.add(files[index])
          const canvas = document.querySelector('.excalidraw canvas.interactive')
          const box = canvas.getBoundingClientRect()
          const options = { bubbles: true, cancelable: true }
          canvas.dispatchEvent(method === 'paste'
            ? new ClipboardEvent('paste', { ...options, clipboardData: transfer })
            : new DragEvent('drop', { ...options, dataTransfer: transfer, clientX: box.left + 150, clientY: box.top + 290 }))
        },
        release() {
          Image.prototype.decode = decode
          state.released = true
          state.held()
        },
      }
      // Delay the real result at the outer webview's delivery boundary.
      const post = window.postMessage
      window.postMessage = function (data, ...args) {
        if (data?.kind === 'result') {
          if (data.reason) state.failures.push(data.reason)
          if (!state.released && data.id === 1) {
            state.held = () => post.call(this, data, ...args)
            return
          }
        }
        post.call(this, data, ...args)
      }
    }, bytes)
    const box = await frame.locator('canvas.interactive').boundingBox()
    assert(box)
    await page.mouse.click(box.x + 150, box.y + 220)
    await page.keyboard.press('r')
    await page.mouse.move(box.x + 150, box.y + 220)
    await page.mouse.down()
    await page.mouse.move(box.x + 205, box.y + 265, { steps: 4 })
    await page.mouse.up()
    await frame.waitForFunction(() => typeof window.imageBatches.held === 'function', undefined, { timeout: 6000 })
    const drawing = async () => readDrawing((await command('snapshot', file)).source)
    const liveImages = current => current.scene.elements.filter(el => el.type === 'image' && !el.isDeleted).map(el => el.fileId)
    assert((await drawing()).scene.elements.some(el => el.type === 'rectangle' && !el.isDeleted))

    await frame.evaluate(() => window.imageBatches.send('paste', 0, 1))
    await frame.getByText('up to 8 MiB at a time', { exact: false }).waitFor({ state: 'visible' })
    await frame.evaluate(() => {
      window.imageBatches.send('paste', 0)
      window.imageBatches.send('drop', 1)
    })
    await frame.waitForFunction(() => window.imageBatches.decoded.size === 2)
    assert.deepEqual(liveImages(await drawing()), [], 'The ordinary write must still be in flight on the board')
    await frame.evaluate(() => window.imageBatches.release())
    const imported = await retry(async () => {
      const reasons = await frame.evaluate(() => window.imageBatches.failures)
      assert.deepEqual(reasons, [], 'Two allowed imports were rejected while the first write was pending')
      const current = await drawing()
      return liveImages(current).length === 2 && current
    }, 'The two 5 MiB imports did not both reach the document')
    const ids = liveImages(imported)
    const targets = ids.map(id => path.join(vault, imported.attachments.get(id)))
    const check = (count, reason) => retry(async () => {
      const current = await drawing()
      assert(current.scene.elements.some(el => el.type === 'rectangle' && !el.isDeleted), 'Undo changed the earlier rectangle')
      const lengths = await Promise.all(targets.map(target => stat(target).then(file => file.size, error => {
        if (error.code === 'ENOENT') return 0
        throw error
      })))
      return JSON.stringify(liveImages(current)) === JSON.stringify(ids.slice(0, count))
        && current.attachments.size === count && ids.slice(0, count).every(id => current.attachments.has(id))
        && lengths.every((size, i) => size === (i < count ? bytes : 0))
    }, reason)
    await check(2, 'Both image elements and their full-size attachments must be written')
    for (const [action, count] of [['Undo', 1], ['Undo', 0], ['Redo', 1], ['Redo', 2]]) {
      await button(action).click()
      await check(count, action + ' must change exactly one import and its attachment')
    }
    await button('Save').click()
    await retry(async () => readDrawing(await readFile(path.join(vault, file), 'utf8')).attachments.size === 2,
      'Saving did not persist both imported images')
    console.log('PASS: two 5 MiB imports behind a held write each save, undo and redo; a single 10 MiB paste is rejected')
    await command('stop')
    return
  }

  if (stage === 'image-import' || stage === 'image-return') {
    for (const [i, file] of cases.entries()) {
      await command('board', file)
      await hasView(boardView, file)
      const frame = await frameWith('.board-toolbar')
      const button = name => frame.locator('.board-toolbar').getByRole('button', { name, exact: true })
      await retry(() => button('Edit drawing').isEnabled(), 'The image test board did not initialize')
      if (stage === 'image-return') {
        await retry(() => frame.evaluate(readPaint, true), 'Imported image did not paint after Obsidian saved the drawing')
        assert(!(await command('snapshot', file)).dirty)
        console.log('PASS: Vsidian paints both attachments after the Obsidian save', file)
        continue
      }
      const method = i === 0 ? 'paste' : 'drop'
      const before = readDrawing((await command('snapshot', file)).source)
      await button('Edit drawing').click()
      const area = await frame.locator('.excalidraw').boundingBox()
      assert(area)
      await page.mouse.click(area.x + 130, area.y + 220)
      await frame.evaluate(async method => {
        const swatch = document.createElement('canvas')
        swatch.width = 64
        swatch.height = 48
        const context = swatch.getContext('2d')
        context.fillStyle = '#19ba50'
        context.fillRect(0, 0, 64, 48)
        const image = await new Promise(resolve => swatch.toBlob(resolve, 'image/png'))
        const transfer = new DataTransfer()
        transfer.items.add(new File([image], 'capture.png', { type: 'image/png' }))
        const canvas = document.querySelector('.excalidraw canvas.interactive') ?? document.querySelector('.excalidraw canvas')
        const bounds = canvas.getBoundingClientRect()
        if (method === 'paste') {
          canvas.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }))
        } else {
          canvas.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer,
            clientX: bounds.left + 130, clientY: bounds.top + 220 }))
        }
      }, method)
      const imported = await retry(async () => {
        const doc = await command('snapshot', file)
        const drawing = readDrawing(doc.source)
        const element = drawing.scene.elements.find(el => el.type === 'image' && !el.isDeleted
          && !before.scene.elements.some(original => original.id === el.id))
        return doc.dirty && element && drawing.attachments.has(element.fileId) && { drawing, element }
      }, 'Import by ' + method + ' did not write a referenced image into the open drawing', 5500)
      const target = imported.drawing.attachments.get(imported.element.fileId)
      assert.equal(imported.drawing.payload.kind, before.payload.kind)
      assert(!imported.drawing.stored.files?.[imported.element.fileId], 'The attachment was duplicated inside the scene')
      const png = await readFile(path.join(vault, target))
      assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
      await retry(() => frame.evaluate(readPaint, true), 'The imported image did not paint in VS Code')
      await button('Undo').click()
      await retry(async () => !readDrawing((await command('snapshot', file)).source).attachments.has(imported.element.fileId),
        'Undo did not take out the newly inserted image reference')
      await retry(async () => {
        try { await readFile(path.join(vault, target)); return false }
        catch (error) { if (error.code === 'ENOENT') return true; throw error }
      }, 'Undo did not remove the single newly created attachment')
      await button('Redo').click()
      await retry(async () => readDrawing((await command('snapshot', file)).source).attachments.has(imported.element.fileId),
        'Redo did not restore the newly inserted image reference')
      assert((await readFile(path.join(vault, target))).equals(png), 'Redo did not restore the PNG contents')
      await retry(() => button('Save').isEnabled(), 'The drawing did not become saveable after redo', 5000).catch(async error => {
        console.error('After redoing the image import:', await frame.locator('.board-mode').innerText(),
          await frame.locator('.board-notice').allTextContents())
        await page.screenshot({ path: path.join(session, 'vscode-image-redo-failure.png') })
        throw error
      })
      await button('Save').click()
      const disk = await retry(async () => {
        const source = await readFile(path.join(vault, file), 'utf8')
        return readDrawing(source).attachments.has(imported.element.fileId) && source
      }, 'Saving did not persist the imported image')
      await writeFile(path.join(session, file + '.with-import'), disk)
      await page.screenshot({ path: path.join(session, 'vscode-image-' + i + '.png') })
      console.log('PASS: VS Code ' + method + ', image pixels, grouped undo/redo and save:', file, target)
    }
    await command('stop')
    return
  }

  for (const [file, heading] of [['Tagged.excalidraw.md', 'A note about Excalidraw'],
    [incomplete, incompleteHeading]]) {
    await command('default', file)
    await hasView(markdownView, file)
    const frame = await frameWith('.cm-content, .markdown-preview-view')
    await frame.getByText(heading, { exact: true }).first().waitFor({ state: 'visible', timeout: 5000 })
  }
  console.log('PASS: a plain tag or an incomplete scene does not replace the Markdown editor')
  const openBoard = page.getByRole('button', { name: /Open in Excalidraw Board/ })
  for (const [i, file] of cases.entries()) {
    await command('default', file)
    await hasView(boardView, file)
    const firstBoard = await frameWith('.board-toolbar')
    await retry(() => firstBoard.evaluate(readPaint), 'The default drawing view did not paint ' + file)
    await firstBoard.getByRole('button', { name: 'Open Markdown', exact: true }).click()
    await hasView(markdownView, file)
    await frameWith('.cm-content, .markdown-preview-view')
    await retry(async () => {
      for (const frame of page.frames()) {
        const note = frame.getByText(invariant, { exact: true }).first()
        if (await note.isVisible()) return true
      }
    }, 'The original note was not visible in the Markdown view')
    await openBoard.click({ timeout: 5000 })
    await hasView(boardView, file)
    console.log('PASS: default canvas and both visible switches', file)
    const frame = await frameWith('.board-toolbar')
    const boardButton = text => frame.locator('.board-toolbar').getByRole('button', { name: text, exact: true })
    await boardButton('Edit drawing').waitFor({ state: 'visible' })
    await retry(() => boardButton('Edit drawing').isEnabled(), 'Canvas did not finish initializing')
    assert.equal(await boardButton('Save').count(), 0)
    assert(!(await command('snapshot', file)).dirty, 'Opening in read-only modified the document')
    const paint = await retry(() => frame.evaluate(readPaint), 'Expected to see a red drawing and a blue local image on the canvas')
    await page.screenshot({ path: path.join(session, 'vscode-read-' + i + '.png') })
    console.log('PASS: painted drawing and local linked image', file, paint)
    await boardButton('Edit drawing').click()
    assert(!(await frame.getByTestId('button-undo').isVisible()), 'Canvas has a duplicate Undo button')
    const canvas = frame.locator('canvas').filter({ visible: true }).last()
    const box = await canvas.boundingBox()
    assert(box)
    const scaleX = box.width / paint.width
    const scaleY = box.height / paint.height
    const rectScale = (paint.right - paint.left) / 140
    const click = {
      x: box.x + (paint.left + 36 * rectScale) * scaleX,
      y: box.y + (paint.top + 34 * rectScale) * scaleY,
    }
    await page.mouse.dblclick(click.x, click.y)
    const text = frame.locator('textarea.excalidraw-wysiwyg')
    await text.waitFor({ state: 'visible', timeout: 6000 })
    const originalLabel = i === 0 ? linkedLabel : 'Original Label'
    const editedLabel = i === 0 ? editedLinkedLabel : 'Edited in Vsidian'
    assert.equal(await text.inputValue(), originalLabel)
    if (i === 0) {
      const draft = originalLabel + '\n## Drawing'
      const reserved = frame.getByText('This label contains a reserved Markdown marker', { exact: false })
      await text.fill(draft)
      await text.press('Escape')
      await reserved.waitFor({ state: 'visible', timeout: 6000 })
      await command('disable-addon')
      await frame.getByText('Enable Vsidian Excalidraw in Vsidian settings to use the board.', { exact: true })
        .waitFor({ state: 'visible', timeout: 6000 })
      await command('enable-addon')
      await reserved.waitFor({ state: 'visible', timeout: 6000 })
      assert.equal((await command('snapshot', file)).source, await readFile(path.join(session, file + '.original'), 'utf8'))
      // The warning consumes a row and changes the canvas origin.
      const resumedPaint = await retry(() => frame.evaluate(readPaint), 'The resumed board did not repaint')
      const resumedBox = await canvas.boundingBox()
      assert(resumedBox)
      await page.mouse.dblclick(
        resumedBox.x + (resumedPaint.left + 36 * rectScale) * resumedBox.width / resumedPaint.width,
        resumedBox.y + (resumedPaint.top + 34 * rectScale) * resumedBox.height / resumedPaint.height,
      )
      await text.waitFor({ state: 'visible', timeout: 6000 })
      assert.equal(await text.inputValue(), draft)
      console.log('PASS: disabling and enabling the addon retained the pending canvas draft')
    }
    await text.fill(editedLabel)
    await text.press('Escape')
    await retry(async () => {
      const snapshot = await command('snapshot', file)
      return snapshot.source.includes(editedLabel + ' ^') && snapshot.dirty
    }, 'Editing a text block was not written to the document')

    await page.mouse.click(box.x + 120, box.y + 170)
    await page.keyboard.press('r')
    await page.mouse.move(box.x + 120, box.y + 190)
    await page.mouse.down()
    await page.mouse.move(box.x + 210, box.y + 236, { steps: 6 })
    await page.mouse.up()
    const count = async n => retry(async () => {
      const snapshot = await command('snapshot', file)
      return readDrawing(snapshot.source).stored.elements.filter(e => !e.isDeleted).length === n && snapshot
    }, 'Expected ' + n + ' visible elements')
    await count(4)
    await boardButton('Undo').click()
    await count(3)
    await boardButton('Redo').click()
    await count(4)
    console.log('PASS: drawing and native undo/redo', file)

    await boardButton('Open Markdown').click()
    const unsaved = await hasView(markdownView, file)
    assert(unsaved.source.includes(editedLabel + ' ^') && unsaved.dirty, 'Switching to Markdown lost unsaved changes')
    assert(unsaved.source.includes(invariant))
    await openBoard.click({ timeout: 5000 })
    await hasView(boardView, file)
    if (await boardButton('Edit drawing').count()) await boardButton('Edit drawing').click()
    await boardButton('Save').click()
    const disk = await retry(async () => {
      const current = await readFile(path.join(vault, file), 'utf8')
      return current === unsaved.source && current
    }, 'Saving did not write the shared Markdown document')
    const saved = readDrawing(disk)
    assert.equal(saved.payload.kind, i === 0 ? 'compressed-json' : 'json')
    assert.equal(saved.attachments.size, 1)
    assert(!(await command('snapshot', file)).dirty)
    await writeFile(path.join(session, file + '.from-vsidian'), disk)
    await page.screenshot({ path: path.join(session, 'vscode-saved-' + i + '.png') })
    console.log('PASS: dirty Markdown switch and save back to the original file', file)
  }
  await command('stop')
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}
function readPaint(requireGreen = false) {
  for (const canvas of document.querySelectorAll('.excalidraw canvas')) {
    if (canvas.width < 100 || canvas.height < 100) continue
    const ctx = canvas.getContext('2d')
    if (!ctx) continue
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
    let left = canvas.width, right = 0, top = canvas.height, bottom = 0, blue = 0, green = 0
    for (let p = 0; p < data.length; p += 4) {
      const r = data[p], g = data[p + 1], b = data[p + 2], a = data[p + 3]
      if (a > 180 && b > 155 && r < 60 && g > 60 && g < 125) blue++
      if (a > 180 && g > 150 && r < 60 && b > 45 && b < 120) green++
      if (a > 180 && r > 160 && g < 80 && b < 80) {
        const x = (p / 4) % canvas.width, y = Math.floor((p / 4) / canvas.width)
        left = Math.min(left, x); right = Math.max(right, x)
        top = Math.min(top, y); bottom = Math.max(bottom, y)
      }
    }
    if (right > left && blue > 50 && (!requireGreen || green > 50)) return { left, right, top, bottom, blue, green, width: canvas.width, height: canvas.height }
  }
}

function hasSecondPdfPage() {
  for (const [index, canvas] of Array.from(document.querySelectorAll('.excalidraw canvas')).entries()) {
    if (!canvas.width || !canvas.height) continue
    const ctx = canvas.getContext('2d')
    if (!ctx) continue
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
    let secondPage = 0, firstPage = 0, xSum = 0, top = canvas.height
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 200) continue
      if (data[i] > 175 && data[i + 1] < 55 && data[i + 2] > 140) {
        secondPage++
        xSum += (i / 4) % canvas.width
        top = Math.min(top, Math.floor(i / 4 / canvas.width))
      }
      if (data[i] > 210 && data[i + 1] > 130 && data[i + 2] < 75) firstPage++
    }
    // Click near the top of the visible artwork, above the board's floating bottom bar.
    if (secondPage > 100 && firstPage === 0) return { canvas: index, x: xSum / secondPage / canvas.width, y: (top + 5) / canvas.height }
  }
  return false
}

function fixturePdf() {
  // Two pages with different solid artwork, so a header or page number cannot pass the paint assertion.
  const streams = ['1 .70 .05 rg 20 20 100 70 re f\n', '.78 .07 .66 rg 20 20 100 70 re f\n']
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>',
    ...[5, 6].map(n => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 140 110] /Resources <<>> /Contents ' + n + ' 0 R >>'),
    ...streams.map(s => '<< /Length ' + s.length + ' >>\nstream\n' + s + 'endstream')]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const [i, object] of objects.entries()) {
    offsets.push(pdf.length)
    pdf += (i + 1) + ' 0 obj\n' + object + '\nendobj\n'
  }
  const xref = pdf.length
  pdf += 'xref\n0 ' + offsets.length + '\n0000000000 65535 f \n' + offsets.slice(1)
    .map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')
  return Buffer.from(pdf + 'trailer\n<< /Size ' + offsets.length + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n')
}
async function createFlow(page, command, frameWith, hasView) {
  const file = 'Drawing.excalidraw.md'
  await command('create')
  const filename = page.locator('.quick-input-widget input:visible').first()
  await filename.waitFor({ state: 'visible', timeout: 10000 })
  await filename.fill(path.join(vault, file))
  await filename.press('Enter')
  await hasView('onegayi.vsidian-excalidraw.board', file)
  const original = await readFile(path.join(vault, file), 'utf8')
  assert.equal(readDrawing(original).scene.elements.length, 0)
  const frame = await frameWith('.board-toolbar')
  const button = text => frame.locator('.board-toolbar').getByRole('button', { name: text, exact: true })
  await button('Edit drawing').click()
  const box = await frame.locator('canvas').filter({ visible: true }).last().boundingBox()
  assert(box)
  await page.mouse.click(box.x + 240, box.y + 240)
  await page.keyboard.press('t')
  await page.mouse.click(box.x + 250, box.y + 245)
  const text = frame.locator('textarea.excalidraw-wysiwyg')
  await text.fill('Example\n## Drawing\nMore text')
  await text.press('Escape')
  await frame.getByText('This label contains a reserved Markdown marker', { exact: false }).waitFor({ state: 'visible' })
  assert(!(await command('snapshot', file)).dirty, 'The reserved label was committed')
  const afterNotice = await frame.locator('canvas').filter({ visible: true }).last().boundingBox()
  assert(afterNotice)
  await page.mouse.dblclick(afterNotice.x + 270, afterNotice.y + 256)
  assert.match(await text.inputValue(), /## Drawing/)
  await text.fill('Created in Vsidian · 双平台')
  await text.press('Escape')
  await retry(async () => (await command('snapshot', file)).source.includes('Created in Vsidian · 双平台 ^'), 'New label not received')
  await button('Save').click()
  const saved = await retry(async () => {
    const source = await readFile(path.join(vault, file), 'utf8')
    return source.includes('Created in Vsidian · 双平台 ^') && source
  }, 'New drawing not saved')
  assert.match(readDrawing(saved).scene.elements[0].id, /^[A-Za-z0-9-]{8}$/)
  await writeFile(path.join(session, file + '.from-vsidian'), saved)
  console.log('PASS: VS Code created and saved a native Markdown drawing', file)
}
