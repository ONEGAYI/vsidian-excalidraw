import assert from 'node:assert/strict'
import { test } from 'node:test'
import { allowedWebOrigins, webLink } from '../src/web.ts'
import { createSceneDiff, displayElements } from '../src/scene.ts'

test('网页卡片只接收无凭据的 HTTP/HTTPS URL', () => {
  assert.equal(webLink('http://example.org/').protocol, 'http:')
  assert.equal(webLink('HTTPS://example.org:443/a?q=1#jump').href, 'https://example.org/a?q=1#jump')
  for (const target of ['file:///test.md', 'javascript:alert(0)', 'https:example.org', 'https://name:pass@example.org']) {
    assert.equal(webLink(target), undefined)
  }
})

test('嵌入策略只接受明确的 HTTPS 来源，忽略路径、通配符、明文和凭据', () => {
  assert.deepEqual(allowedWebOrigins([
    'https://example.org', 'https://EXAMPLE.org:443/', 'https://example.org:444/',
    'https://example.org/a', 'https://example.org/#', 'https://*.example.org', 'http://example.org', "https://example.org/ 'unsafe-inline'",
    'https://name@example.org', null,
  ]), ['https://example.org', 'https://example.org:444'])
  assert.deepEqual(allowedWebOrigins(null), [])
})

test('原始 HTML 帧只投影为矩形，移动时不写回类型或自定义数据', () => {
  const original = { id: 'rawframe', type: 'iframe', x: 10, customData: { generationData: { html: '<p>Source</p>' } } }
  const [displayed] = displayElements([original])
  assert.equal(displayed.type, 'rectangle')
  assert.equal(original.type, 'iframe')
  assert.deepEqual(createSceneDiff([original.id])([displayed], [{ ...displayed, x: 15 }]), {
    elements: [{ id: 'rawframe', fields: { x: 15 } }],
  })
})
