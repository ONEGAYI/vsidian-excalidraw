import assert from 'node:assert/strict'
import { test } from 'node:test'
import lz from 'lz-string'

const prefix = '\uFEFF---\r\nexcalidraw-plugin: parsed\r\ntags: [sketch]\r\n---\r\n\r\n# Review notes\r\nDo not rewrite this text.\r\n'
const scene = {
  type: 'excalidraw', version: 2, source: 'obsidian-test',
  elements: [
    { id: 'label001', type: 'text', text: 'Outdated scene text', originalText: 'Outdated scene text', x: 24, y: 20, customData: { upstream: true } },
    { id: 'shape001', type: 'rectangle', x: 25, y: 80, link: null },
    { id: 'image001', type: 'image', fileId: 'photoid', x: 120, y: 90 },
  ],
  appState: { viewBackgroundColor: '#ffffff', pluginField: 'keep' },
  files: {},
}
const data = '\r\n# Excalidraw Data\r\n\r\n## Text Elements\r\nStatus [[Roadmap|plan]] ^label001\r\n\r\n'
  + '## Element Links\r\nshape001: [[Roadmap#Milestone]]\r\n\r\n'
  + '## Embedded Files\r\nphotoid: [[assets/picture.png]]\r\n\r\n%%\r\n## Drawing\r\n'
const suffix = '\r\n```\r\n%%\r\n\r\n后续备注\r\n'
const compressed = (value) => lz.compressToBase64(JSON.stringify(value))
const fixture = (kind = 'json', value = scene) => prefix + data + '```' + kind + '\r\n'
  + (kind === 'json' ? JSON.stringify(value) : compressed(value)) + suffix

test('读取 Obsidian 的普通与压缩图档，以 Markdown 中的文字、元素链接和图片映射为准', async () => {
  const format = await import('../src/format.ts')
  for (const kind of ['json', 'compressed-json']) {
    const parsed = format.readDrawing(fixture(kind))
    assert.equal(parsed.scene.elements[0].originalText, 'Status [[Roadmap|plan]]')
    assert.equal(parsed.scene.elements[1].link, '[[Roadmap#Milestone]]')
    assert.deepEqual([...parsed.attachments], [['photoid', 'assets/picture.png']])
  }
  assert.equal(format.isDrawing('# Excalidraw Data\n\n## Drawing\n'), false)
})

test('编辑已解析的文字时，保留实际画面和可编辑的原始笔记链接', async () => {
  const { readDrawing, writeDrawing } = await import('../src/format.ts')
  const { createSceneDiff } = await import('../src/scene.ts')
  const rawText = 'Status [[Roadmap|plan]]'
  const text = 'Status plan'
  for (const kind of ['json', 'compressed-json']) {
    const original = { ...scene.elements[0], rawText, text, originalText: text }
    const source = fixture(kind, { ...scene, elements: [original, ...scene.elements.slice(1)] })
    const before = readDrawing(source).scene.elements
    assert.equal(before[0].text, text)
    assert.equal(before[0].originalText, rawText)
    const originalText = before[0].originalText.replace('Status', 'Progress')
    const diff = createSceneDiff(before.map(element => element.id))
    const patch = diff(before, [{ ...before[0], originalText }, ...before.slice(1)])
    let saved = source
    for (const edit of writeDrawing(source, patch).sort((a, b) => b.from - a.from)) {
      saved = saved.slice(0, edit.from) + edit.text + saved.slice(edit.to)
    }
    assert.match(saved, /Progress \[\[Roadmap\|plan\]\] \^label001/)
    assert.equal(readDrawing(saved).stored.elements[0].rawText, 'Progress [[Roadmap|plan]]')
  }
})

test('回写保留压缩形式、正文、属性及附件，只同步改过的图形和文字记录', async () => {
  const { readDrawing, writeDrawing } = await import('../src/format.ts')
  for (const kind of ['json', 'compressed-json']) {
    const source = fixture(kind)
    const edits = writeDrawing(source, {
      elements: [
        { id: 'label001', fields: { text: 'Updated note', originalText: 'Updated note' } },
        { id: 'shape001', fields: { x: 45 } },
        { id: 'newtext1', fields: { type: 'text', originalText: 'New label', text: 'New label' } },
      ],
      order: ['shape001', 'label001', 'image001', 'newtext1'],
    })
    let saved = source
    for (const edit of [...edits].sort((a, b) => b.from - a.from)) {
      saved = saved.slice(0, edit.from) + edit.text + saved.slice(edit.to)
    }
    assert(saved.startsWith(prefix))
    assert(saved.endsWith(suffix))
    assert(saved.includes('Updated note ^label001\r\n'))
    assert(saved.includes('New label ^newtext1\r\n'))
    assert(saved.includes('shape001: [[Roadmap#Milestone]]\r\n'))
    assert(saved.includes('photoid: [[assets/picture.png]]\r\n'))
    const drawing = readDrawing(saved)
    assert.equal(drawing.payload.kind, kind)
    assert.deepEqual(drawing.scene.elements.map(e => e.id), ['shape001', 'label001', 'image001', 'newtext1'])
    assert.equal(drawing.scene.elements[0].x, 45)
    assert.equal(drawing.scene.elements[1].originalText, 'Updated note')
    assert.deepEqual(drawing.stored.elements[1].customData, { upstream: true })
    assert.deepEqual(drawing.stored.elements[2], scene.elements[2])
    assert.deepEqual(drawing.stored.appState, scene.appState)
  }
})

test('不把会冒充 Obsidian 保留段的多行文字写进图档', async () => {
  const { newDrawing, writeDrawing } = await import('../src/format.ts')
  const example = 'Label\n## Drawing\n```json\n{}\n```\nMore text'
  for (const text of [example, 'line 1\n%%\nline 2', 'Note with another block ^12345abc\nline 2']) {
    assert.throws(() => writeDrawing(newDrawing(), {
      elements: [{ id: 'textabcd', fields: { type: 'text', text, originalText: text } }],
    }), /reserved-text/)
  }
  assert.doesNotThrow(() => writeDrawing(newDrawing(), {
    elements: [{ id: 'textabcd', fields: { type: 'text', originalText: '## Step 1\n[[A linked note]]' } }],
  }))
})

test('读取旧文件中歧义的文字章节时明确拒绝，而不是截断显示', async () => {
  const { readDrawing } = await import('../src/format.ts')
  const ambiguous = fixture().replace('Status [[Roadmap|plan]] ^label001', 'Title\r\n## Text Elements\r\nContinuation ^label001')
  assert.throws(() => readDrawing(ambiguous), /ambiguous-drawing-sections/)
})

test('回读第一条文字的段首换行，并保留每条文字结尾的空格', async () => {
  const { readDrawing, writeDrawing } = await import('../src/format.ts')
  const source = fixture().replace('Status [[Roadmap|plan]] ^label001', '\r\nFirst label   ^label001')
  const edits = writeDrawing(source, {
    elements: [{ id: 'newtext1', fields: { type: 'text', originalText: 'Second label\t ' } }],
  })
  let saved = source
  for (const edit of edits.sort((a, b) => b.from - a.from)) {
    saved = saved.slice(0, edit.from) + edit.text + saved.slice(edit.to)
  }
  const labels = readDrawing(saved).scene.elements.filter(e => e.type === 'text')
  assert.deepEqual(labels.map(e => e.originalText), ['\nFirst label  ', 'Second label\t '])
  const remove = writeDrawing(saved, { elements: [{ id: 'label001', fields: { isDeleted: true } }] })
  for (const edit of remove.sort((a, b) => b.from - a.from)) {
    saved = saved.slice(0, edit.from) + edit.text + saved.slice(edit.to)
  }
  assert.equal(readDrawing(saved).scene.elements.find(e => e.id === 'newtext1').originalText, 'Second label\t ')
})

test('笔记后记里的 Excalidraw Data 示例不影响前面的真实画板', async () => {
  const { readDrawing, writeDrawing } = await import('../src/format.ts')
  const notes = '\r\n实现说明\r\n\r\n~~~markdown\r\n# Excalidraw Data\r\n~~~\r\n'
  const source = fixture() + notes
  const edits = writeDrawing(source, { elements: [{ id: 'shape001', fields: { x: 45 } }] })
  const saved = source.slice(0, edits[0].from) + edits[0].text + source.slice(edits[0].to)
  assert(saved.endsWith(notes))
  assert.equal(readDrawing(saved).scene.elements[1].x, 45)
})

test('忽略 Markdown 围栏内的完整 Drawing，保存只改真实图档', async () => {
  const { readDrawing, writeDrawing } = await import('../src/format.ts')
  const sample = {
    ...scene, elements: [{ id: 'sample01', type: 'rectangle', x: 50 }],
  }
  for (const kind of ['json', 'compressed-json']) {
    const body = kind === 'json' ? JSON.stringify(sample) : compressed(sample)
    const example = '# Excalidraw Data\r\n\r\n## Text Elements\r\nSample ^sample02\r\n\r\n%%\r\n'
      + '## Drawing\r\n```' + kind + '\r\n' + body + '\r\n```\r\n%%\r\n'
    const original = fixture(kind)
    const document = prefix + '格式说明\r\n\r\n````markdown\r\n' + example + '````\r\n' + original.slice(prefix.length)
    const notes = '\r\n后记\r\n\r\n  ~~~~markdown\r\n' + example + '  ~~~~\r\n'
    const source = document + notes
    const drawing = readDrawing(source)
    assert.equal(drawing.payload.kind, kind)
    assert.deepEqual(drawing.scene.elements.map(e => e.id), scene.elements.map(e => e.id))
    const edits = writeDrawing(source, { elements: [{ id: 'shape001', fields: { x: 45 } }] })
    assert.equal(edits.length, 1)
    const [edit] = edits
    assert.deepEqual({ from: edit.from, to: edit.to }, { from: drawing.payload.from, to: drawing.payload.to })
    const saved = source.slice(0, edit.from) + edit.text + source.slice(edit.to)
    assert(saved.startsWith(document.slice(0, document.indexOf(data))))
    assert(saved.endsWith(suffix + notes))
    assert.equal(readDrawing(saved).scene.elements[1].x, 45)
  }
})

test('正文真的有两个独立 Drawing 时拒绝保存，而不是猜一个写回', async () => {
  const { readDrawing, writeDrawing } = await import('../src/format.ts')
  for (const kind of ['json', 'compressed-json']) {
    const source = fixture(kind) + fixture(kind).slice(prefix.length)
    assert.throws(() => readDrawing(source), /drawing-section/)
    assert.throws(() => writeDrawing(source, { elements: [{ id: 'shape001', fields: { x: 45 } }] }), /drawing-section/)
  }
})

test('文字记录内的 Markdown 围栏不吞掉后面的真实 Drawing', async () => {
  const { readDrawing, writeDrawing } = await import('../src/format.ts')
  const source = fixture()
  const label = '示例：\n```js\nconst a = 1\n```'
  const edits = writeDrawing(source, { elements: [{ id: 'label001', fields: { originalText: label } }] })
  let saved = source
  for (const edit of edits.sort((a, b) => b.from - a.from)) {
    saved = saved.slice(0, edit.from) + edit.text + saved.slice(edit.to)
  }
  assert.equal(readDrawing(saved).scene.elements[0].originalText, label)
})

test('第一段文字紧接标题，不在 Obsidian 中引入额外的段首换行', async () => {
  const { newDrawing, writeDrawing } = await import('../src/format.ts')
  let source = newDrawing()
  const edits = writeDrawing(source, {
    elements: [{ id: 'textabcd', fields: { type: 'text', originalText: 'Created in Vsidian · 双平台' } }],
  })
  for (const edit of edits.sort((a, b) => b.from - a.from)) {
    source = source.slice(0, edit.from) + edit.text + source.slice(edit.to)
  }
  assert.match(source, /## Text Elements\nCreated in Vsidian · 双平台 \^textabcd\n/)
})

test('新图片通过 Embedded Files 引用同库附件，已有附件及绘图编码不变', async () => {
  const { newDrawing, writeDrawing, readDrawing } = await import('../src/format.ts')
  const image = '1234567890abcdef1234567890abcdef'
  const target = 'excalidraw-' + image + '.png'
  for (const source of [newDrawing(), fixture('compressed-json')]) {
    const original = readDrawing(source)
    const edits = writeDrawing(source, {
      elements: [{ id: 'newimage', fields: { type: 'image', fileId: image } }],
      attachments: [{ id: image, target }],
    })
    let saved = source
    for (const edit of edits.sort((a, b) => b.from - a.from)) {
      saved = saved.slice(0, edit.from) + edit.text + saved.slice(edit.to)
    }
    const next = readDrawing(saved)
    assert.equal(next.payload.kind, original.payload.kind)
    assert.deepEqual([...next.attachments], [...original.attachments, [image, target]])
    assert.equal(next.stored.elements.find(el => el.id === 'newimage').fileId, image)
    assert.deepEqual(next.stored.files, original.stored.files)
  }
})
