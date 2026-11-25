import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { parse } from 'yaml'

const workflow = parse(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'))
const { release, marketplace } = workflow.jobs
const candidate = release.steps.find(step => step.id === 'candidate')

test('GitHub Release 从本地标签取说明，不传入与之冲突的仓库参数', () => {
  const script = release.steps.find(step => step.run?.includes('gh release create')).run
  const command = script.replace(/\\\n\s*/g, ' ').split('\n').find(line => line.startsWith('gh release create '))
  assert.match(command, /--verify-tag\s+--notes-from-tag\b/)
  assert.doesNotMatch(command, /\s(?:--repo\b|-R\b)/)
})

test('从 main 补发时仍校验标签，并发布该标签的 CI 产物', () => {
  assert.equal(workflow.on.workflow_dispatch?.inputs.tag.required, true)
  assert.match(release.if, /github\.ref == 'refs\/heads\/main'/)
  assert.match(candidate.run, /git checkout --detach "refs\/tags\/\$RELEASE_TAG"/)
  assert.match(candidate.run, /git merge-base --is-ancestor HEAD refs\/remotes\/origin\/main/)
  assert.match(candidate.run, /--event push --branch main --commit "\$commit" --status success/)
  assert.equal(marketplace.needs, 'release')
  const download = marketplace.steps.find(step => step.run?.includes('gh release download'))
  assert.equal(download.env.RELEASE_TAG, '${{ needs.release.outputs.tag }}')
  assert.match(download.run, /gh release download "\$RELEASE_TAG"/)
})
