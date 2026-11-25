import assert from 'node:assert/strict'
import { test } from 'node:test'

test('只提交实际改动、为新元素分配 Obsidian ID，并同步绑定引用', async () => {
  const { createSceneDiff } = await import('../src/scene.ts')
  const before = [
    { id: 'shape001', type: 'rectangle', x: 8, index: 'a0', link: null },
    { id: 'text0001', type: 'text', originalText: 'old', index: 'a1' },
  ]
  const long = 'new-arrow-element-123'
  const after = [
    before[0],
    { ...before[1], originalText: 'changed' },
    { id: long, type: 'arrow', startBinding: { elementId: 'shape001', focus: 0 } },
    { id: 'ab_cdEFG-another-text-id', type: 'text', containerId: long, originalText: 'new' },
  ]
  const diff = createSceneDiff(['shape001', 'text0001', 'new-arro'])
  const patch = diff(before, after)
  assert.deepEqual(patch.elements[0], { id: 'text0001', fields: { originalText: 'changed' } })
  assert.equal(patch.elements.length, 3)
  assert.match(patch.elements[1].id, /^[a-zA-Z0-9_-]{8}$/)
  assert.notEqual(patch.elements[1].id, 'new-arro')
  assert.deepEqual(patch.elements[1].fields.startBinding, { elementId: 'shape001', focus: 0 })
  assert.match(patch.elements[2].id, /^[A-Za-z0-9-]{8}$/)
  assert.equal(patch.elements[2].fields.containerId, patch.elements[1].id)
  assert.deepEqual(patch.order, ['shape001', 'text0001', patch.elements[1].id, patch.elements[2].id])
  assert.deepEqual(diff(after, after), { elements: [] })
  assert.deepEqual(diff(after, [...after.slice(0, 3), { ...after[3], isDeleted: true }]).elements,
    [{ id: patch.elements[2].id, fields: { isDeleted: true } }])
})
