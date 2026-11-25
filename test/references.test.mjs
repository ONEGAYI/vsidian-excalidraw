import assert from 'node:assert/strict'
import { test } from 'node:test'
import { localReference, notePreview } from '../src/references.ts'

test('recognizes Obsidian note anchors and positive PDF pages without mutating source selectors', () => {
  assert.deepEqual(localReference('[[Library/Notes#^blue-card|Label]]', true), {
    kind: 'note', path: 'Library/Notes.md', fragment: '^blue-card',
  })
  assert.deepEqual(localReference('doc pages.pdf#page=2&rect=2,4,12,16|100%'), {
    kind: 'pdf', path: 'doc pages.pdf', fragment: 'page=2&rect=2,4,12,16', page: 2, rect: [2, 4, 12, 16],
  })
  assert.equal(localReference('book.pdf#page=0'), undefined)
  assert.equal(localReference('[[https://example.com/text.md]]', true), undefined)
  assert.equal(localReference('photo.png'), undefined)
})

test('note preview selects a real heading or a block and renders inert Markdown', () => {
  const source = '---\nvisible: false\n---\n\n# Main\n\n```md\n## Target Heading\n```\n\n' +
    '## Target **Heading**\n\n**Nice** [visit](https://example.org) ![picture](https://example.net)\n\n' +
    '### Child\n\nValue\n\n## Elsewhere\n\nThe requested block ^test-block\n\nOthers\n'
  assert.match(notePreview(source, 'target heading').html, /<strong>Nice<\/strong> <span>visit<\/span> picture/)
  assert.match(notePreview(source, 'target heading').html, /<h3>Child<\/h3>/)
  assert.doesNotMatch(notePreview(source, 'target heading').html, /https:|Elsewhere|visible: false/)
  assert.equal(notePreview(source, '^test-block').html, '<p>The requested block</p>\n')
  assert.equal(notePreview(source, 'missing'), undefined)
  assert.match(notePreview('<script>alert(1)</script>', '').html, /&lt;script&gt;/)
})
