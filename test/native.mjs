import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { newDrawing, readDrawing } from '../src/format.ts'

const [stage, sessionPath, vsidianSource, vscodeExe, vsidianExtension, obsidianExe, pluginSource, installedAddon] = process.argv.slice(2)
if (!stage || !sessionPath || !vsidianSource || !vscodeExe || !vsidianExtension || !obsidianExe || !pluginSource) {
  throw new Error('Usage: node test/native.mjs <seed|vscode|reopen|create|new> <session-dir> <Vsidian-source> <Code.exe> <Vsidian-extension> <Obsidian.exe> <Obsidian-plugin-dir> [addonDir]')
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
} else if (stage === 'vscode' || stage === 'create') {
  if (stage === 'vscode') for (const file of cases) await cp(path.join(session, file + '.original'), path.join(vault, file))
  const scope = path.join(session, stage + '-user')
  await mkdir(path.join(scope, 'User'), { recursive: true })
  await writeFile(path.join(scope, 'User', 'settings.json'), JSON.stringify({
    'workbench.startupEditor': 'none', 'window.zoomLevel': 0, 'security.workspace.trust.enabled': false,
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
} else if (stage === 'reopen' || stage === 'new') {
  const selected = stage === 'new' ? ['Drawing.excalidraw.md'] : cases
  for (const file of selected) await cp(path.join(session, file + '.from-vsidian'), path.join(vault, file))
  await obsidian(async page => {
    for (const file of selected) {
      const expectedText = stage === 'new' ? 'Created in Vsidian · 双平台'
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
      if (stage === 'reopen') {
        const saved = readDrawing(await readFile(path.join(vault, file), 'utf8'))
        assert.deepEqual(snapshot.elements.map(e => e.id).sort(), saved.scene.elements.filter(e => !e.isDeleted).map(e => e.id).sort())
        assert(snapshot.elements.some(e => e.type === 'text' && e.text === expectedText))
        assert.equal(snapshot.elements.length, 4)
        const imageId = snapshot.elements.find(e => e.type === 'image').fileId
        await page.waitForFunction(id => id in app.workspace.activeLeaf.view.excalidrawAPI.getFiles(), imageId, { polling: 100 })
        await retry(() => page.evaluate(readPaint), 'Obsidian did not paint the chart and linked image after reopening')
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
  const command = async (action, name) => {
    const id = ++requestNo
    const request = path.join(session, prefix + '-req-' + id)
    await writeFile(request + '.tmp', JSON.stringify({ action, name }))
    await rename(request + '.tmp', request)
    return retry(() => readJson(path.join(session, prefix + '-res-' + id)), 'VS Code did not acknowledge ' + action + ' ' + name)
  }
  const hasView = async (view, file) => retry(async () => {
    const snapshot = await command('snapshot', file)
    return snapshot.active === view && snapshot
  }, 'VS Code did not activate ' + view)
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

  if (stage === 'create') {
    await createFlow(page, command, frameWith, hasView)
    await command('stop')
    return
  }

  await command('default', 'Readme.md')
  await hasView(markdownView, 'Readme.md')
  console.log('PASS: ordinary Markdown still opens in Vsidian')
  for (const [i, file] of cases.entries()) {
    await command('markdown', file)
    await hasView(markdownView, file)
    await frameWith('.cm-content, .markdown-preview-view')
    await retry(async () => {
      for (const frame of page.frames()) {
        const note = frame.getByText(invariant, { exact: true }).first()
        if (await note.isVisible()) return true
      }
    }, 'The original note was not visible in the Markdown view')
    await command('board', file)
    await hasView(boardView, file)
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
    await command('board', file)
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
function readPaint() {
  for (const canvas of document.querySelectorAll('.excalidraw canvas')) {
    if (canvas.width < 100 || canvas.height < 100) continue
    const ctx = canvas.getContext('2d')
    if (!ctx) continue
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
    let left = canvas.width, right = 0, top = canvas.height, bottom = 0, blue = 0
    for (let p = 0; p < data.length; p += 4) {
      const r = data[p], g = data[p + 1], b = data[p + 2], a = data[p + 3]
      if (a > 180 && b > 155 && r < 60 && g > 60 && g < 125) blue++
      if (a > 180 && r > 160 && g < 80 && b < 80) {
        const x = (p / 4) % canvas.width, y = Math.floor((p / 4) / canvas.width)
        left = Math.min(left, x); right = Math.max(right, x)
        top = Math.min(top, y); bottom = Math.max(bottom, y)
      }
    }
    if (right > left && blue > 50) return { left, right, top, bottom, blue, width: canvas.width, height: canvas.height }
  }
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
