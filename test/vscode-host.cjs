const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { setTimeout: wait } = require('node:timers/promises')
const vscode = require('vscode')

exports.run = async () => {
  const session = process.env.VSED_SESSION
  const prefix = 'vscode-' + process.env.VSED_RUN
  const vault = vscode.workspace.workspaceFolders[0].uri
  assert.equal(path.relative(vault.fsPath, path.resolve(session, 'vault')), '')
  const core = vscode.extensions.getExtension('onegayi.vsidian')
  const addon = vscode.extensions.getExtension('onegayi.vsidian-excalidraw')
  assert(core && addon)
  await core.activate()
  await addon.activate()
  await fs.writeFile(path.join(session, prefix + '-ready'), JSON.stringify({ vscode: vscode.version, vsidian: core.packageJSON.version }))
  for (let id = 1; ; id++) {
    const request = path.join(session, prefix + '-req-' + id)
    let input
    for (;;) {
      try {
        input = JSON.parse(await fs.readFile(request, 'utf8'))
        break
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        await wait(65)
      }
    }
    const uri = input.name && vscode.Uri.joinPath(vault, input.name)
    let data
    if (input.action === 'default') {
      await vscode.commands.executeCommand('vscode.open', uri)
    } else if (input.action === 'source-beside') {
      const document = await vscode.workspace.openTextDocument(uri)
      await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside, preview: false })
    } else if (input.action === 'reopen-with') {
      void vscode.commands.executeCommand('workbench.action.reopenWithEditor')
    } else if (input.action === 'group-views') {
      data = { views: vscode.window.tabGroups.all.map(group => group.activeTab?.input?.viewType) }
    } else if (input.action === 'close-left-group') {
      assert(await vscode.window.tabGroups.close(vscode.window.tabGroups.all[0]))
    } else if (input.action === 'markdown') {
      await vscode.commands.executeCommand('vscode.openWith', uri, 'onegayi.vsidian.editor', { preview: false })
    } else if (input.action === 'board') {
      await vscode.commands.executeCommand('vsidianExcalidraw.open', uri)
    } else if (input.action === 'create') {
      void vscode.commands.executeCommand('vsidianExcalidraw.create')
    } else if (input.action === 'disable-addon' || input.action === 'enable-addon') {
      await vscode.commands.executeCommand('onegayi.vsidian._test.addonSetEnabled', {
        addonId: addon.id, enabled: input.action === 'enable-addon',
      })
    } else if (input.action === 'close-active') {
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
    } else if (input.action === 'web-policy-set') {
      data = { outcome: await vscode.commands.executeCommand('onegayi.vsidian._test.addonSettingsUpdate', {
        addonId: addon.id, scope: 'workspace', values: { webPreviewOrigins: input.value },
      }) }
    } else if (input.action === 'web-policy-get') {
      data = await vscode.commands.executeCommand('onegayi.vsidian._test.addonSettingsGet', { addonId: addon.id })
    } else if (input.action === 'web-policy-show') {
      await vscode.commands.executeCommand('onegayi.vsidian.openSettings')
    } else if (input.action === 'web-policy-close') {
      await vscode.commands.executeCommand('onegayi.vsidian._test.addonSettingsCloseArea')
      await vscode.commands.executeCommand('onegayi.vsidian._test.closeSettingsPage')
    } else if (input.action === 'snapshot') {
      const document = await vscode.workspace.openTextDocument(uri)
      data = { source: document.getText(), dirty: document.isDirty, version: document.version }
    }
    const active = vscode.window.tabGroups.activeTabGroup.activeTab?.input
    data = { ...data, active: active?.viewType, activePath: active?.uri?.fsPath }
    const response = path.join(session, prefix + '-res-' + id)
    await fs.writeFile(response + '.tmp', JSON.stringify(data))
    await fs.rename(response + '.tmp', response)
    if (input.action === 'stop') break
  }
}
